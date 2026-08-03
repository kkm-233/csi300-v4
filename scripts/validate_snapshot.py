#!/usr/bin/env python3
import json,sys
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'public/data/v4-snapshot.json';d=json.loads(p.read_text(encoding='utf-8'))
assert d['schemaVersion']==1
assert d['current']['state'] in {'hold','warning','defense'}
assert 0<=d['current']['targetPosition']<=1
assert d['current']['entryGrade'] in {'strong','standard','test','wait'}
assert len(d['chartSeries'])>=2
print('snapshot OK:',d['status']['dataDate'],d['current']['state'],d['current']['targetPosition'])
