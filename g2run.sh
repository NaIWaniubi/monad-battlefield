#!/bin/bash
# G2 helper: environment cache-cleaner repeatedly deletes the node_modules
# junction (RUNBOOK documents this). Re-link from E:\myzcode\.cache\mb-nm,
# then run the given command in repo root. Usage: sh g2run.sh npx vitest run
ROOT="E:/myzcode/.zcode/workspace/draft-81a597ed-95d5-459f-921e-fb54ed87f785/monad-battlefield"
cd "$ROOT" || exit 1
if [ ! -e node_modules/vitest ]; then
  rm -rf node_modules 2>/dev/null
  powershell -NoProfile -Command "New-Item -ItemType Junction -Path 'E:\myzcode\.zcode\workspace\draft-81a597ed-95d5-459f-921e-fb54ed87f785\monad-battlefield\node_modules' -Target 'E:\myzcode\.cache\mb-nm\node_modules'" >/dev/null 2>&1
fi
exec "$@"
