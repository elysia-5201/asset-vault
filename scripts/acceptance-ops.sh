#!/bin/bash
# 运维类验收：AC7 缺文件标记 / AC6 kill -9 崩溃恢复 / D5 作业失败原因可读。
# 自己起独立实例（端口 7320、独立数据目录），不干扰共享的 7317。
set -u
R=<repo>
D=$R/data-ops
P=7320
B=http://127.0.0.1:$P
PY=python3
say() { echo; echo "### $*"; }
rm -rf "$D"; mkdir -p "$D"
cd "$R"

start_server() {
  ASSETVAULT_DATA=$D PORT=$P node --import tsx apps/server/src/main.ts > logs/ops-server.log 2>&1 &
  SRV=$!
  for i in $(seq 1 40); do
    curl -s --max-time 2 $B/api/health > /dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "  !! server did not start"; return 1
}
stop_server() { kill -9 $SRV 2>/dev/null; wait $SRV 2>/dev/null; }

say "start server ($P, data=$D)"; start_server && echo "  up pid=$SRV"

say "AC7 缺文件标记：建临时扫描根 → 扫描 → 删文件 → 重扫 → 恢复 → 重扫"
T=$D/tmp-scan; mkdir -p "$T"
cp "%LIBRARY%/素材库/Milky-Way.zip" "$T/sample-7770001.zip"
curl -s --max-time 10 -X POST $B/api/scan -H 'content-type: application/json' -d "{\"path\":\"$T\"}" > /dev/null
sleep 3
p1=$(curl -s --max-time 10 "$B/api/items?limit=5" | $PY -c "import json,sys;d=json.load(sys.stdin)['items'];print(d[0]['id'] if d else 0)")
s1=$(curl -s --max-time 10 "$B/api/items/$p1" | $PY -c "import json,sys;d=json.load(sys.stdin);print(d['assets'][0]['status'] if d['assets'] else 'none')")
echo "  after first scan: item=$p1 status=$s1"
rm -f "$T/sample-7770001.zip"
curl -s --max-time 10 -X POST $B/api/scan -H 'content-type: application/json' -d "{\"path\":\"$T\"}" > /dev/null
sleep 3
s2=$(curl -s --max-time 10 "$B/api/items/$p1" | $PY -c "import json,sys;d=json.load(sys.stdin);print(d['assets'][0]['status'] if d['assets'] else 'none')")
echo "  after delete+rescan: status=$s2  (期望 missing)"
cp "%LIBRARY%/素材库/Milky-Way.zip" "$T/sample-7770001.zip"
curl -s --max-time 10 -X POST $B/api/scan -H 'content-type: application/json' -d "{\"path\":\"$T\"}" > /dev/null
sleep 3
s3=$(curl -s --max-time 10 "$B/api/items/$p1" | $PY -c "import json,sys;d=json.load(sys.stdin);print(d['assets'][0]['status'] if d['assets'] else 'none')")
echo "  after restore+rescan: status=$s3  (期望 present)"
echo "  AC7 verdict: $([ "$s1" = present ] && [ "$s2" = missing ] && [ "$s3" = present ] && echo PASS || echo FAIL)"

say "D5 作业失败原因：导入不存在的路径，jobs.error 必须非空"
curl -s --max-time 10 -X POST $B/api/import/paths -H 'content-type: application/json' -d '{"paths":["/nonexistent/definitely-missing.zip"]}' > /dev/null
sleep 4
curl -s --max-time 10 "$B/api/jobs?limit=3" | $PY -c "
import json,sys
for j in json.load(sys.stdin)['jobs'][:3]:
    print('  job',j['id'],j['kind'],j['state'],'error=',repr(j['error'])[:90])
"
say "AC6 kill -9 崩溃恢复（有界扫描，避免恢复后被大任务阻塞）"
BIG=$D/tmp-big; mkdir -p "$BIG"
i=0
for f in %LIBRARY%/素材库/*.zip; do cp "$f" "$BIG/fake-$i.zip" 2>/dev/null; i=$((i+1)); [ $i -ge 30 ] && break; done
echo "  prepared $i files in $BIG"
curl -s --max-time 10 -X POST $B/api/scan -H 'content-type: application/json' -d "{\"path\":\"$BIG\",\"deep\":true}" > /dev/null
sleep 1
before=$(curl -s --max-time 20 "$B/api/jobs?limit=50" | $PY -c "import json,sys;js=json.load(sys.stdin)['jobs'];print(sum(1 for j in js if j['state'] not in ('done','failed','cancelled','abandoned','queued')))" 2>/dev/null || echo '?')
echo "  inflight(non-queued) before kill: $before"
kill -9 $SRV; wait $SRV 2>/dev/null; echo "  killed -9 pid=$SRV"
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$P " || break; sleep 0.5; done
(ss -ltn 2>/dev/null | grep -q ":$P ") && echo "  !! port $P still held" || echo "  port $P released"
parts=$(find "$D/media" -name '*.part' 2>/dev/null | wc -l); echo "  .part files after crash: $parts"
start_server && echo "  restarted pid=$SRV"
curl -s --max-time 40 "$B/api/jobs?limit=50" | $PY -c "import json,sys;js=json.load(sys.stdin)['jobs'];print('  states after restart:',[(j['id'],j['state']) for j in js[:6]]);bad=[j for j in js if j['state'] in ('resolving','fetching','materializing','indexing','matching','releasing','releasing_done')];print('  leftover inflight:',len(bad))"
EV=$(curl -s --max-time 40 "$B/api/jobs/1/events")
echo "  job1 events: $(echo "$EV" | $PY -c "import json,sys;print(' -> '.join(e['event']+'('+e['to_state']+')' for e in json.load(sys.stdin)['events']))")"
echo "  job1 含 recovered 次数: $(echo "$EV" | grep -o recovered | wc -l)"
say "DONE"
