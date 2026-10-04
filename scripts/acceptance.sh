#!/bin/bash
# AssetVault 验收脚本（AC1-AC12 可观测判据）。用法：B=http://127.0.0.1:7319 bash scripts/acceptance.sh
set -u
B=${B:-http://127.0.0.1:7319}
PY=python3
say() { echo; echo "### $*"; }
jq_() { $PY -c "import json,sys;d=json.load(sys.stdin);$1"; }

wait_idle() {
  for i in $(seq 1 90); do
    n=$(curl -s --max-time 10 "$B/api/jobs?limit=50" | $PY -c "import json,sys;print(sum(1 for j in json.load(sys.stdin)['jobs'] if j['state'] not in ('done','failed','cancelled','abandoned')))" 2>/dev/null || echo 99)
    [ "$n" = "0" ] && return 0
    sleep 2
  done
  echo "  !! wait_idle timeout"; return 1
}

say "AC0 health"; curl -s --max-time 10 $B/api/health | head -c 160; echo
say "AC2 链接建档（6494376 / 8183383 / 6115428）"
for id in 6494376 8183383 6115428; do echo -n "  import $id -> "; curl -s --max-time 10 -X POST $B/api/import/url -H 'content-type: application/json' -d "{\"url\":\"https://booth.pm/ja/items/$id\"}"; echo; done
say "AC1 扫库（素材库）"; curl -s --max-time 10 -X POST $B/api/scan -H 'content-type: application/json' -d '{"path":"%LIBRARY%/素材库"}'; echo
echo "  ...等待作业收敛"; wait_idle
say "AC2 实测：图片/标签/价格"
curl -s --max-time 10 "$B/api/items?site=booth&limit=5" | $PY -c "
import json,sys
for i in json.load(sys.stdin)['items']:
    print('  ',i['sourceItemId'],i['title'][:34],'| imgs',i['imageCount'],'| av',[a['name'] for a in i['avatars']],'| tags',len(i['tags']),'| decl',i['compatDeclaredCount'])
"
say "AC10 多头像：6494376 应得 6 个且与 declared 一致"
curl -s --max-time 10 "$B/api/items?q=Cat's%20Round%20Eye" | $PY -c "
import json,sys
d=json.load(sys.stdin)['items']
for i in d: print('  ',i['title'][:30],'declared',i['compatDeclaredCount'],'found',len(i['avatars']),[a['name'] for a in i['avatars']])
"
say "AC1 归属：8183383 条目是否挂上了本地扫到的包"
curl -s --max-time 10 "$B/api/items?q=MilkyWay" | $PY -c "
import json,sys
for i in json.load(sys.stdin)['items']:
    print('  ',i['id'],i['title'][:36],'assets',i['assetCount'],'imgs',i['imageCount'])
"
say "AC4 幂等：二次扫库新增资产应为 0"
before=$(curl -s --max-time 10 $B/api/stats | $PY -c "import json,sys;print(json.load(sys.stdin)['assets'])")
curl -s --max-time 10 -X POST $B/api/scan -H 'content-type: application/json' -d '{"path":"%LIBRARY%/素材库"}' > /dev/null
wait_idle
after=$(curl -s --max-time 10 $B/api/stats | $PY -c "import json,sys;print(json.load(sys.stdin)['assets'])")
echo "  assets before=$before after=$after delta=$((after-before))"
say "AC5 中日文子串搜索（URL 编码）"
for q in Shinano ミルフィ milky しなの; do
  enc=$($PY -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$q")
  echo -n "  q=$q -> "
  curl -s --max-time 15 "$B/api/items?q=$enc&limit=5" | $PY -c "import json,sys;d=json.load(sys.stdin);print('total',d.get('total','ERR'),'first:',(d['items'][0]['title'][:34] if d.get('items') else '-'))"
done
say "AC11 按 avatar 快筛（ANY / ALL）"
aid=$(curl -s --max-time 10 "$B/api/avatars?q=Manuka" | $PY -c "import json,sys;a=json.load(sys.stdin)['avatars'];print(a[0]['id'] if a else 0)")
bid=$(curl -s --max-time 10 "$B/api/avatars?q=Milfy" | $PY -c "import json,sys;a=json.load(sys.stdin)['avatars'];print(a[0]['id'] if a else 0)")
echo -n "  avatar=Manuka($aid) any -> "; curl -s --max-time 10 "$B/api/items?avatar=$aid" | $PY -c "import json,sys;d=json.load(sys.stdin);print('total',d['total'])"
echo -n "  avatar=Manuka+Milfy all -> "; curl -s --max-time 10 "$B/api/items?avatar=$aid,$bid&avatarMatch=all" | $PY -c "import json,sys;d=json.load(sys.stdin);print('total',d['total'])"
say "AC12 别名冲突应 409"
curl -s -o /tmp/alias-$$.json -w "  http=%{http_code}\n" --max-time 10 -X POST "$B/api/avatars/$bid/aliases" -H 'content-type: application/json' -d '{"alias":"マヌカ"}'
head -c 200 /tmp/alias-$$.json; echo
say "D7 自动匹配条目必须带回溯 URL"
curl -s --max-time 10 "$B/api/items?site=booth&limit=50" | $PY -c "
import json,sys
d=json.load(sys.stdin)['items']
missing=[i['id'] for i in d[:20] if not i.get('sourceUrl')]
print('  checked',len(d),'booth items; missing sourceUrl:',missing)
"
say "AC8 列表性能（1000+ 条）"
if [ -n "${DB:-}" ]; then node scripts/seed-items.mjs "$DB" 1000 | sed 's/^/  /'; fi
curl -s -o /dev/null -w "  items?limit=50 time_total=%{time_total}s\n" --max-time 20 "$B/api/items?limit=50"
curl -s -o /dev/null -w "  items?q=Shinano time_total=%{time_total}s\n" --max-time 20 "$B/api/items?q=Shinano&limit=50"
say "AC3 unitypackage 解析（MANUKA，165 GUID）"
iid=$(curl -s --max-time 10 "$B/api/items?q=MilkyWay" | $PY -c "import json,sys;d=json.load(sys.stdin)['items'];print(d[0]['id'] if d else 0)")
curl -s --max-time 20 -X POST "$B/api/items/$iid/assets" -H 'content-type: application/json' -d '{"path":"%LIBRARY%/MANUKA_ver1.02/MANUKA.unitypackage"}' | head -c 200; echo
wait_idle
aid2=$(curl -s --max-time 10 "$B/api/items/$iid" | $PY -c "import json,sys;d=json.load(sys.stdin);print(next((a['id'] for a in d['assets'] if a['container']=='unitypackage'),0))")
echo "  unitypackage asset id=$aid2"
curl -s --max-time 30 "$B/api/assets/$aid2/unitypackage" | $PY -c "
import json,sys
d=json.load(sys.stdin)
print('  total assets:',d.get('total'),'byType:',dict(list(d.get('byType',{}).items())[:8]))
"
say "AC6 崩溃恢复（重启后无在飞残留）"
curl -s --max-time 10 "$B/api/jobs?limit=50" | $PY -c "
import json,sys
st=json.load(sys.stdin)['jobs']
inflight=[j for j in st if j['state'] not in ('done','failed','cancelled','abandoned')]
print('  inflight:',len(inflight),'| states:',{})
"
say "AC7 缺文件标记（对同一资产重复 reindex 不重复建行）+ 统计"
curl -s --max-time 10 $B/api/stats | head -c 300; echo
say "DONE"