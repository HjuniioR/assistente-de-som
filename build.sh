#!/bin/sh
cd "$(dirname "$0")"
python3 - <<'PY'
s=open('app.html').read(); c=open('core.js').read()
open('assistente-de-som.html','w').write(s.replace('/*__CORE__*/', c))
PY
