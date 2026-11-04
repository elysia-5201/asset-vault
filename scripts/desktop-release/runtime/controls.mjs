import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDest, stageFile } from "./transport.mjs";
import { buildManifest } from "./manifest-gen.mjs";

const D = process.argv[2];
const read = (f) => readFileSync(join(D, f), "utf8");
const cases = [];
const ok = (n, c, d = "") => cases.push({ n, ok: !!c, detail: d });
const throws = (n, fn, re) => { try { fn(); ok(n, false, "no throw"); } catch (e) { ok(n, re.test(e.message), e.message); } };

const root = mkdtempSync(join(tmpdir(), "av-tx-"));
ok("transport accepts normal rel", resolveDest(root, "a/b/c.txt").startsWith(root));
throws("transport rejects dotdot", () => resolveDest(root, "../escape.bin"), /dotdot/);
throws("transport rejects nested dotdot", () => resolveDest(root, "a/../../x"), /dotdot/);
throws("transport rejects absolute", () => resolveDest(root, "/etc/passwd"), /absolute/);
throws("transport rejects drive", () => resolveDest(root, "C:/x"), /drive/);
throws("transport rejects UNC", () => resolveDest(root, "\\\\srv\\share"), /UNC/);
throws("transport rejects empty component", () => resolveDest(root, "a//b"), /empty component/);
let escaped = false;
try { stageFile(root, "../escaped.bin", Buffer.from("x")); } catch { escaped = true; }
ok("transport stageFile dotdot throws", escaped);
ok("transport no file escaped root", !existsSync(join(root, "..", "escaped.bin")));
rmSync(root, { recursive: true, force: true });

const good = { rel: "apps/desktop/build/server.mjs", bytes: 1, old: "a".repeat(64), new: "b".repeat(64), action: "replace" };
const idx = { rel: "apps/web/dist/index.html", bytes: 1, old: "a".repeat(64), new: "b".repeat(64), action: "replace-LAST" };
const js = { rel: "apps/web/dist/assets/index-X.js", bytes: 1, old: null, new: "b".repeat(64), action: "add-new-exclusive" };
ok("manifest-gen accepts valid", buildManifest([good, js, idx]).payload.length === 3);
throws("manifest-gen rejects missing old", () => buildManifest([{ rel: "a", bytes: 1, new: "b".repeat(64), action: "replace" }, js, idx]), /old must be present/);
throws("manifest-gen rejects bad new sha", () => buildManifest([{ ...good, new: "zz" }, js, idx]), /new not sha64/);
throws("manifest-gen rejects bad action", () => buildManifest([{ ...good, action: "delete" }, js, idx]), /not whitelisted/);
throws("manifest-gen rejects duplicate", () => buildManifest([good, good, js, idx]), /duplicate/);
throws("manifest-gen rejects index action", () => buildManifest([good, js, { ...idx, action: "replace" }]), /index action/);
throws("manifest-gen rejects newJS with old", () => buildManifest([good, { ...js, old: "a".repeat(64) }, idx]), /old must be null/);
throws("manifest-gen rejects two newJS", () => buildManifest([good, js, { ...js, rel: "apps/web/dist/assets/index-Y.js" }, idx]), /exactly one/);

const schema = read("exec-schema.ps1"), guard = read("guard.ps1"), core = read("io-core.ps1");
const apply = read("apply.ps1"), fixture = read("fixture.ps1"), close = read("close.ps1");
const backup = read("backup-db.ps1"), mg = read("manifest-gen.mjs"), archive = read("archive-marker.ps1"), start = read("start.ps1");
for (const [n, s] of [["apply", apply], ["fixture", fixture], ["close", close], ["backup", backup], ["archive", archive], ["start", start]]) {
  ok(n + " dot-sources exec-schema", /exec-schema\.ps1/.test(s));
}
ok("schema owns all four names", /New-StageName/.test(schema) && /New-ReceiptName/.test(schema) && /New-MarkerArchiveName/.test(schema) && /New-DbBackupName/.test(schema));
ok("core preflight before writes", core.indexOf("Invoke-CorePreflight") < core.indexOf("Invoke-CoreReplace $s $d"));
ok("core preflight checks marker first", /Invoke-CorePreflight[\s\S]{0,200}marker exists/.test(core));
ok("core rechecks staged before each write", /staged changed before write/.test(core));
ok("guard requires literal old key", /payload\.old missing/.test(guard));
ok("guard validates sha64", /Assert-Sha64/.test(guard));
ok("guard action whitelist", /ExecActions -notcontains/.test(guard));
ok("guard no fake offset", !/offset=/.test(guard) && /completeness unprovable/.test(guard));
ok("close receipt after stop proof", close.indexOf("$p.CloseMainWindow()") < close.lastIndexOf("Write-CloseReceipt $receipt $paths.Receipt"));
ok("close ALREADY-STOPPED writes receipt", /ALREADY-STOPPED receipt=/.test(close) && /alreadyStopped = \$true/.test(close));
ok("close ALREADY-STOPPED exits 0", /ALREADY-STOPPED[\s\S]{0,400}exit 0/.test(close));
ok("archive uses baselineOld", /baselineOld/.test(archive) && !/\.oldAssets/.test(archive));
ok("archive consumes single schema path", /\$paths\.OldMarkerArchive/.test(archive) && !/New-MarkerArchiveName/.test(archive));
ok("schema has no 00000000 placeholder", !/00000000/.test(schema));
ok("schema owns backup receipt name", /New-BackupReceiptName/.test(schema));
ok("backup copies sidecars", /vault\.db-wal/.test(backup) && /vault\.db-shm/.test(backup));
ok("backup explicit sidecar:none", /sidecar:none/.test(backup));
ok("backup verifies source stability", /source sha changed/.test(backup));
ok("backup writes own receipt", /BackupReceipt/.test(backup) && /DB-BACKUP-OK/.test(backup));
ok("backup no sql/checkpoint/delete", !/sqlite|checkpoint|Remove-Item/i.test(backup));
ok("resolver is pure (no clock/random)", !/Get-Date|Get-Random|New-Guid/.test(schema.slice(schema.indexOf("function Resolve-ExecPaths"), schema.indexOf("function Assert-Sha64"))));
ok("resolver takes stamp+releaseId", /Resolve-ExecPaths\(\[string\]\$AppRoot, \[string\]\$DataPrivate, \[string\]\$Stamp, \[string\]\$ReleaseId\)/.test(schema));
ok("all entries pass manifest stamp/releaseId", [apply, close, backup, archive, start].every((s) => s.includes("ManifestData.stamp") && s.includes("ManifestData.releaseId")));
ok("guard validates releaseId/stamp", /releaseId must be 8 hex/.test(guard) && /stamp must be yyyyMMdd-HHmmss/.test(guard));
ok("manifest-gen emits roots+releaseId+stamp", /releaseId,/.test(mg) && /stamp,/.test(mg) && /appRoot:/.test(mg));
ok("start uses unique server payload", /server payload must appear exactly once/.test(start) && !/payload\[0\]/.test(start));
ok("archive validates marker handoff", /Assert-MarkerForArchive/.test(archive));
ok("start uses identity encoding", /Accept-Encoding/.test(start) && /identity/.test(start));
ok("start checks preserved bytes", /Assert-PreservedBytes/.test(start));
ok("fixture NEG proves zero change", /Assert-Same/.test(fixture) && /target"/.test(fixture));
ok("fixture POS checks backup bytes", /backup bytes != old/.test(fixture));
ok("fixture POS checks marker post", /marker post != new/.test(fixture));

// --- sample vs real guard requirements (field-by-field, not one regex) ---
const sample = JSON.parse(read("fixture-manifest.sample.json"));
ok("sample.releaseId 8hex", /^[0-9a-f]{8}$/.test(sample.releaseId || ""));
ok("sample.stamp yyyyMMdd-HHmmss", /^[0-9]{8}-[0-9]{6}$/.test(sample.stamp || ""));
ok("sample roots absolute", /^[A-Za-z]:\\/.test(sample.appRoot || "") && /^[A-Za-z]:\\/.test(sample.dataPrivate || ""));
const ACT = ["replace", "replace-LAST", "add-new-exclusive", "DO-NOT-WRITE"];
let sIdx = 0, sNew = 0, sBad = [];
for (const p of sample.payload) {
  for (const k of ["rel", "old", "new", "bytes", "action"]) if (!(k in p)) sBad.push(p.rel + ":missing " + k);
  if (!/^[0-9a-f]{64}$/.test(p.new || "")) sBad.push(p.rel + ":new not sha64");
  if (p.old !== null && !/^[0-9a-f]{64}$/.test(p.old || "")) sBad.push(p.rel + ":old not sha64");
  if (!Number.isInteger(p.bytes) || p.bytes < 0) sBad.push(p.rel + ":bytes not int");
  if (!ACT.includes(p.action)) sBad.push(p.rel + ":action not whitelisted");
  if (p.rel === "apps/web/dist/index.html") { sIdx++; if (p.action !== "replace-LAST") sBad.push("index action"); if (p.old === null) sBad.push("index old null"); }
  else if (p.action === "replace-LAST") sBad.push(p.rel + ":replace-LAST off index");
  if (p.action === "add-new-exclusive") { sNew++; if (p.old !== null) sBad.push(p.rel + ":newJS old not null"); }
  else if (p.old === null) sBad.push(p.rel + ":old null not add-new-exclusive");
}
ok("sample payload satisfies guard", sBad.length === 0, sBad.join(";"));
ok("sample index exactly once", sIdx === 1);
ok("sample exactly one newJS", sNew === 1);
ok("sample doNotWrite shape", sample.doNotWrite.every((d) => typeof d.rel === "string" && /^[0-9a-f]{64}$/.test(d.sha256)));
ok("sample baselineOld real path", Object.keys(sample.baselineOld).includes("apps/web/dist/assets/index-Bf2TnWaM.js"));
ok("core pinned r10 0ee06b18", /^0ee06b18/.test(createHash("sha256").update(read("io-core.ps1")).digest("hex")));
ok("fixture pinned r11 c535fa9f", /^c535fa9f/.test(createHash("sha256").update(read("fixture.ps1")).digest("hex")));
ok("archive pinned r11 98690a49", /^98690a49/.test(createHash("sha256").update(read("archive-marker.ps1")).digest("hex")));
ok("schema pinned r11 1c42b226", /^1c42b226/.test(createHash("sha256").update(read("exec-schema.ps1")).digest("hex")));

// --- r8: preflight must re-assert rel safety before any path join (manifest can be mutated after read) ---
const preflightBody = core.slice(core.indexOf("function Invoke-CorePreflight"), core.indexOf("function Invoke-CoreReplace"));
ok("core preflight calls Assert-SafeRel", /Assert-SafeRel \$rel/.test(preflightBody));
const preflightLoop = preflightBody.slice(preflightBody.indexOf("foreach ($p in $ordered)"));
ok("core preflight safe-rel before stage join", preflightLoop.indexOf("Assert-SafeRel $rel") < preflightLoop.indexOf("Join-Path $Stage"));
ok("core preflight safe-rel before target join", preflightLoop.indexOf("Assert-SafeRel $rel") < preflightLoop.indexOf("Join-Path $Root"));
ok("core preflight safe-rel inside payload loop", preflightBody.indexOf("foreach ($p in $ordered)") < preflightBody.indexOf("Assert-SafeRel $rel"));
ok("guard dotdot covers backslash", guard.includes("(^|[/\\\\])\\.\\.([/\\\\]|$)"));

// --- r9: B1-B4 / I1-I6 structural checks ---
ok("backup has ManifestPath param", /\[Parameter\(Mandatory=\$true\)\]\[string\]\$ManifestPath/.test(backup));
ok("backup reads manifest before resolve", backup.indexOf("Read-ExecManifest $ManifestPath") >= 0 && backup.indexOf("Read-ExecManifest $ManifestPath") < backup.indexOf("Resolve-ExecPaths"));
ok("backup binds ManifestData before resolve", backup.indexOf("$ManifestData = Read-ExecManifest") < backup.indexOf("Resolve-ExecPaths"));
ok("backup asserts exact receipt path", /Assert-ExactPath \$ReceiptPath \$paths\.Receipt/.test(backup));
ok("backup asserts stopped", /Assert-Stopped/.test(backup));
ok("backup handles alreadyStopped receipt", /Assert-CloseReceipt/.test(backup) && /alreadyStopped/.test(schema));
ok("start uses health.build.serverSha256", /Get-HealthServerSha/.test(start) && !/\$h\.serverSha\b/.test(start));
ok("start prints served sha", /serverSha=\$servedSha/.test(start));
ok("archive uses File.Move", /\[IO\.File\]::Move/.test(archive));
ok("archive checks destination absent", /archive exists/.test(archive));
ok("archive verifies marker gone", /marker still present/.test(archive));
ok("archive no Remove-Item", !/Remove-Item/.test(archive));
ok("archive asserts exact marker path", /Assert-ExactPath \$MarkerPath \$paths\.Marker/.test(archive));
ok("close asserts production exe", /Assert-ExactPath \(\[string\]\$snap\.mainExe\) \$prodExe/.test(close));
ok("close checks mainCreated", /mainCreated missing/.test(close));
ok("close jobs gate before CloseMainWindow", close.indexOf("Get-InFlightJobs") < close.indexOf("$p.CloseMainWindow()"));
ok("close uses Get-CloseDecision", /Get-CloseDecision/.test(close));
ok("core preflight calls Assert-PreservedBytes", /Assert-PreservedBytes/.test(core));
ok("core preserved before writes", core.indexOf("Assert-PreservedBytes") < core.indexOf("Invoke-CoreReplace $s $d"));
for (const [n, s] of [["apply", apply], ["close", close], ["backup", backup], ["archive", archive], ["start", start]]) {
  ok(n + " asserts manifest roots", /Assert-ManifestRoots \$ManifestData \$AppRoot \$DataPrivate/.test(s));
  ok(n + " roots before resolve", s.indexOf("Assert-ManifestRoots") < s.indexOf("Resolve-ExecPaths"));
}
ok("apply asserts exact stage", /Assert-ExactPath \$stageFull \$paths\.StageRoot/.test(apply));
ok("start asserts index references new JS", /does not reference new JS/.test(start));
ok("start asserts index not old JS", /still references old JS/.test(start));
ok("start uses static asset URL", /Get-StaticAssetUrl/.test(start));
ok("guard old null requires add-new-exclusive", /old null requires add-new-exclusive/.test(guard));
ok("guard validates appRoot/dataPrivate", /manifest\.appRoot/.test(guard) && /manifest\.dataPrivate/.test(guard));
ok("guard validates baselineOld", /baselineOld empty/.test(guard) && /baselineOld\(/.test(guard));
ok("guard exposes Assert-ManifestShape", /function Assert-ManifestShape/.test(guard));
ok("read manifest calls shape", /return Assert-ManifestShape \$m/.test(guard));
for (const fn of ["Get-StaticAssetUrl", "Get-HealthServerSha", "Get-CloseDecision", "Assert-ManifestRoots", "Assert-ExactPath", "Assert-MarkerForStart", "Assert-MarkerForArchive", "Assert-PreservedBytes"]) {
  ok("schema exposes " + fn, new RegExp("function " + fn).test(schema));
}
ok("fixture reloads manifest per case", /function New-CaseManifest/.test(fixture));
ok("fixture exact dotdot anchor", /\^GUARD: dotdot in rel:/.test(fixture));
ok("fixture doNotWrite NEG", /\^CORE: doNotWrite changed:/.test(fixture));
ok("fixture baselineOld NEG", /\^CORE: baselineOld changed:/.test(fixture));

// --- r10: F1-F5 fixes, F6 inspect, NEG5 + real marker handoff ---
ok("guard exposes Get-ProcessSet", /function Get-ProcessSet/.test(guard));
ok("guard exposes Get-ListenSet", /function Get-ListenSet/.test(guard));
ok("guard exposes Get-ProcessById", /function Get-ProcessById/.test(guard));
ok("guard stopped uses helpers", /function Assert-Stopped \{[\s\S]*?Get-ProcessSet[\s\S]*?Get-ListenSet/.test(guard));
ok("guard no silent query", !/SilentlyContinue/.test(guard));
ok("guard process query stop", /Get-CimInstance Win32_Process -Filter "Name='AssetVault.exe'" -ErrorAction Stop/.test(guard));
ok("guard listen full set then filter", /Get-NetTCPConnection -State Listen -ErrorAction Stop/.test(guard) && /Where-Object \{ \[int\]\$_.LocalPort -eq \$Port \}/.test(guard));
ok("guard listen notfound is empty", /CmdletizationQuery_NotFound/.test(guard));
ok("close snapshot uses helpers", /function Get-AppSnapshot \{[\s\S]*?Get-ProcessSet[\s\S]*?Get-ListenSet/.test(close));
ok("close no silent query", !/SilentlyContinue/.test(close));
ok("start uses listen helper", /Get-ListenSet 7317/.test(start));
ok("start owner equals startedPid", /port owner \$owner != startedPid \$startedPid/.test(start));
ok("start owner process via helper", /Get-ProcessById \$owner/.test(start));
ok("backup validates close receipt", /Assert-CloseReceipt \$rc \$prodExe/.test(backup));
ok("backup no bool cast receipt", !/\[bool\]\$rc\.alreadyStopped/.test(backup));
ok("backup checks sidecar set", /Assert-DbSidecarSet \$dbNames/.test(backup));
ok("backup sidecar scan before copy", backup.indexOf("Assert-DbSidecarSet") < backup.indexOf("Get-SourceSet"));
ok("apply backup gate before core", apply.indexOf("Assert-BackupReceiptShape") >= 0 && apply.indexOf("Assert-BackupReceiptShape") < apply.indexOf("Invoke-CoreApplyAll"));
ok("apply verifies backup files", /Assert-BackupFiles \$backupReceipt/.test(apply));
ok("apply validates close receipt", /Assert-CloseReceipt \$closeReceipt \$prodExe/.test(apply));
ok("archive inspect only", /\[switch\]\$InspectOnly/.test(archive) && /MARKER-INSPECT-OK/.test(archive));
ok("archive inspect before move", archive.indexOf("$InspectOnly") < archive.indexOf("[IO.File]::Move"));
for (const fn of ["Assert-CloseReceipt", "Assert-BackupReceiptShape", "Assert-BackupFiles", "Assert-DbSidecarSet", "Assert-IntValue", "Get-RequiredProp"]) {
  ok("schema exposes " + fn, new RegExp("function " + fn).test(schema));
}
ok("fixture NEG5 Assert-Under", /NEG5 Assert-Under independent counterexample/.test(fixture) && /Assert-Under "C:\\outside/.test(fixture));
ok("fixture real marker to start", /Assert-MarkerForStart \$mk \$m \$startPaths/.test(fixture));
ok("close receipt binds releaseId/stamp", /releaseId = \[string\]\$ManifestData\.releaseId/.test(close) && /stamp = \[string\]\$ManifestData\.stamp/.test(close));
ok("backup passes releaseId/stamp", /Assert-CloseReceipt \$rc \$prodExe \(\[string\]\$ManifestData\.releaseId\) \(\[string\]\$ManifestData\.stamp\)/.test(backup));
ok("apply passes releaseId/stamp", /Assert-CloseReceipt \$closeReceipt \$prodExe \(\[string\]\$ManifestData\.releaseId\) \(\[string\]\$ManifestData\.stamp\)/.test(apply));
ok("backup receipt binds releaseId/stamp", /releaseId = \[string\]\$ManifestData\.releaseId/.test(backup) && /stamp = \[string\]\$ManifestData\.stamp/.test(backup));
ok("apply passes backup releaseId/stamp", /Assert-BackupReceiptShape \$backupReceipt \$paths \$closeReceiptSha \(\[string\]\$ManifestData\.releaseId\) \(\[string\]\$ManifestData\.stamp\)/.test(apply));

// --- r11: legacy archive declaration + harness instrument fixes ---
ok("schema exposes Assert-LegacyArchiveDeclaration", /function Assert-LegacyArchiveDeclaration/.test(schema));
ok("schema exposes Assert-LegacyMarkerSha", /function Assert-LegacyMarkerSha/.test(schema));
ok("schema exposes Get-ExpectedArchivePost", /function Get-ExpectedArchivePost/.test(schema));
ok("archive reads legacyArchive", /legacyArchive/.test(archive));
ok("archive legacy sha before move", archive.indexOf("Assert-LegacyMarkerSha") >= 0 && archive.indexOf("Assert-LegacyMarkerSha") < archive.indexOf("[IO.File]::Move"));
ok("archive inspect prints marker sha", /markerSha256/.test(archive) && /validation/.test(archive));
ok("archive inspect fails closed", /if \(\$verdict -ne "OK"\) \{ exit 1 \}/.test(archive));
ok("guard validates legacyArchive", /manifest\.legacyArchive/.test(guard));
ok("guard legacy markerPath absolute", /legacyArchive\.markerPath must be an absolute drive path/.test(guard));
ok("apply suppresses close receipt stdout", /Assert-CloseReceipt \$closeReceipt \$prodExe \(\[string\]\$ManifestData\.releaseId\) \(\[string\]\$ManifestData\.stamp\) \| Out-Null/.test(apply));
ok("apply suppresses backup receipt stdout", /Assert-BackupReceiptShape \$backupReceipt \$paths \$closeReceiptSha \(\[string\]\$ManifestData\.releaseId\) \(\[string\]\$ManifestData\.stamp\) \| Out-Null/.test(apply));
ok("backup suppresses close receipt stdout", /Assert-CloseReceipt \$rc \$prodExe \(\[string\]\$ManifestData\.releaseId\) \(\[string\]\$ManifestData\.stamp\) \| Out-Null/.test(backup));
ok("start stays strict on marker root", /Assert-ExactPath \(\[string\]\$Marker\.root\) \$Paths\.AppRoot "marker root"/.test(schema));
ok("legacy exception not in start", !/legacyArchive/.test(start));
ok("legacy exception not in apply", !/legacyArchive/.test(apply));
ok("legacy exception not in close", !/legacyArchive/.test(close));
ok("legacy exception not in backup", !/legacyArchive/.test(backup));
const shCase = read("shadow/shadow-case.ps1"), shStubs = read("shadow/shadow-stubs.ps1"), shH = read("shadow/shadow-harness.ps1");
ok("shadow-case runs entry in current scope", /Invoke-Expression \$body/.test(shCase) && !/&\s*\$entryPath/.test(shCase));
ok("shadow-case strips param block", /function Remove-EntryParamBlock/.test(shCase));
ok("shadow-case pins PSScriptRoot to CaseDir", /\$body\.Replace\('\$PSScriptRoot', "'" \+ \(\$CaseDir/.test(shCase));
ok("shadow-case asserts stubs in effect", /stub not in effect/.test(shCase) && /Get-Command -Name \$n -CommandType Function/.test(shCase));
ok("shadow-case rejects module cmdlet", /stub resolved to a module cmdlet/.test(shCase));
ok("shadow-stubs counts hits", /function Add-ShadowHit/.test(shStubs) && /Add-ShadowHit "Get-CimInstance"/.test(shStubs));
ok("shadow-harness redirects stdout/stderr", /RedirectStandardOutput/.test(shH) && /RedirectStandardError/.test(shH));
ok("shadow-harness reads ExitCode", /\$proc\.ExitCode/.test(shH));
ok("shadow-harness no native stderr capture", !/2>&1 \| Out-String/.test(shH));
ok("shadow-harness diff join array", /\[string\]::Join\(\[Environment\]::NewLine, @\(\$diff\)\)/.test(shH));
ok("shadow-harness keep message truthful", /root kept for evidence \(default/.test(shH));
ok("shadow-harness legacy cases", /L1 legacy archive positive/.test(shH) && /L10 start rejects legacy marker/.test(shH));
ok("shadow-harness min hits gate", /stub hits \$hitTotal < expected/.test(shH));

const fail = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ total: cases.length, failed: fail }, null, 1));
process.exit(fail.length === 0 ? 0 : 1);
