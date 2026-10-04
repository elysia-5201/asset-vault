#!/bin/bash
# AC6 真·崩溃恢复：kill -9 正在跑作业的进程，重启后必须无锁泄漏、无 .part、作业回到 queued 且有 recovered 事件。
# DB 直接读（不走 HTTP），避免恢复后大任务阻塞事件循环影响判定。
set -u
R=<repo>
D=$R/data-accept6
P=7321
B=http://127.0.0.1:$P
cd "$R"
rm -rf "$D"; mkdir -p "$D"
Q() { node -e "
const D=require('better-sqlite3');
const db=new D('$D/vault.db',{readonly:true});
const js=db.prepare('SELECT id,kind,state,attempts FROM jobs ORDER BY id').all();
const rec=db.prepare(\"SELECT COUNT(*) c FROM job_events WHERE event='recovered'\").get().c;
const inflight=js.filter(j=>['resolving','fetching','materializing','indexing','matching','releasing','releasing_done'].includes(j.state));
console.log(JSON.stringify({jobs:js,recoveredEvents:rec,inflight:inflight.map(j=>j.id+':'+j.state)},null,0));
"; }

echo "### 启动 7321"
ASSETVAULT_DATA=$D PORT=$P node --import tsx apps/server/src/main.ts > logs/ac06-server.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -s --max-time 2 $B/api/health > /dev/null 2>&1 && break; sleep 0.5; done

echo "### 起一个大扫描（%LIBRARY%, deep）并在作业进行中 kill -9"
curl -s --max-time 10 -X POST $B/api/scan -H 'content-type: application/json' -d '{"path":"%LIBRARY%","deep":true}' > /dev/null
sleep 2
echo "  before kill: $(Q)"
kill -9 $SRV; wait $SRV 2>/dev/null
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$P " || break; sleep 0.5; done
echo "  after kill (DB, readonly): $(Q)"
echo "  .part files: $(find "$D/media" -name '*.part' 2>/dev/null | wc -l)"

echo "### 重启"
ASSETVAULT_DATA=$D PORT=$P node --import tsx apps/server/src/main.ts > logs/ac06-server2.log 2>&1 &
SRV=$!
sleep 5
echo "  after restart (DB, readonly): $(Q)"
echo "  job_events 里 recovered 计数: $(Q | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).recoveredEvents))")"
kill -9 $SRV 2>/dev/null; wait $SRV 2>/dev/null
echo "### DONE"
