"""Extract lexical spelling exceptions; these are candidate forms, never model decisions.
Usage: python3 scripts/build-inflections.py /path/to/wordnet.zip
WordNet license: public/data/WORDNET-LICENSE.txt
"""
import json,re,sys,zipfile
from pathlib import Path
z=zipfile.ZipFile(sys.argv[1]);out={}
for pos in ['noun','verb']:
 by_base={}
 for line in z.read('wordnet/'+pos+'.exc').decode().splitlines():
  form,*bases=line.split()
  if not re.fullmatch(r"[a-z]+(?:[-'][a-z]+)*",form):continue
  for base in bases:
   if base!=form and re.fullmatch(r"[a-z]+(?:[-'][a-z]+)*",base):by_base.setdefault(base,set()).add(form)
 out[pos]={base:sorted(forms) for base,forms in sorted(by_base.items())}
Path('lib/inflection-exceptions.json').write_text(json.dumps(out,separators=(',',':'))+'\n')
