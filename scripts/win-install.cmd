@echo off
setlocal
cd /d <drive>:\tool\asset-vault
if not exist logs mkdir logs
echo === node/npm ===
node -v
npm -v
echo === npm install (win32-x64 prebuilds) ===
call npm install --no-audit --no-fund
echo NPM_EXIT=%ERRORLEVEL%
echo === native modules check ===
node -e "const D=require('better-sqlite3');const d=new D(':memory:');d.exec('create table t(x)');d.prepare('insert into t values (1)').run();console.log('better-sqlite3 OK', d.prepare('select count(*) c from t').get().c);"
node -e "require('sharp');console.log('sharp OK')"
node -e "const b=require('7zip-bin');console.log('7zip-bin OK', b.path7za)"
node -e "require('chokidar');console.log('chokidar OK')"
echo DONE
