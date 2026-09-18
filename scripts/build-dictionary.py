"""Build the browser dictionary from the original Princeton WordNet 3.0 archive.
Usage: python3 scripts/build-dictionary.py /path/to/wordnet.zip
Source: https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip
"""
import json, re, sys, zipfile
from pathlib import Path
from collections import defaultdict
z = zipfile.ZipFile(sys.argv[1])
lex = {int(a):b for a,b,*_ in (line.split() for line in z.read('wordnet/lexnames').decode().splitlines() if line.strip())}
categories=defaultdict(set)
freq=defaultdict(int)
for line in z.read('wordnet/cntlist.rev').decode().splitlines():
    p=line.split()
    if len(p)>2: freq[p[0].split('%')[0].lower()] += int(p[-1])
for pos in ['noun','verb','adj','adv']:
    for line in z.read('wordnet/data.'+pos).decode().splitlines():
        if not line or not line[0].isdigit(): continue
        p=line.split('|')[0].split()
        category=lex[int(p[1])]
        for i in range(int(p[3],16)):
            w=re.sub(r'\([^)]*\)$','',p[4+2*i]).lower()
            if re.fullmatch(r"[a-z]+(?:[-'][a-z]+)*",w): categories[w].add(category)
    for line in z.read('wordnet/'+pos+'.exc').decode().splitlines():
        p=line.split()
        if not p: continue
        form=p[0].lower()
        if re.fullmatch(r"[a-z]+(?:[-'][a-z]+)*",form):
            for lemma in p[1:]:
                categories[form].update(categories.get(lemma.lower(),[]))
            if not categories[form]: categories[form].add(pos+'.other')
            freq[form]=max(freq[form],1)
function_words="a an the this that these those i you he she it we they me him her us them my your his its our their mine yours ours theirs myself yourself himself herself itself ourselves themselves who whom whose which what whatever whoever where when why how whether all any both each either every few many more most much neither no none other several some such another anything everything nothing something anyone everyone nobody someone anywhere everywhere nowhere somewhere and but or nor so yet because although if unless until while since as than then therefore however also too not never always often sometimes already still just only even very quite rather almost enough really perhaps yes please thanks hello hi goodbye okay well now here there today tomorrow yesterday be am is are was were been being have has had having do does did doing can could will would shall should may might must ought need dare to of in on at by for with about from into through during before after above below over under between among against without within around along across behind beyond near off out up down away back together once twice again let's i'm you're he's she's it's we're they're don't doesn't didn't isn't aren't wasn't weren't can't couldn't won't wouldn't shouldn't mustn't i've you've we've they've i'll you'll he'll she'll we'll they'll i'd you'd he'd she'd we'd they'd".split()
for i,w in enumerate(function_words): categories[w].add('function'); freq[w]+=100000-i
ids=sorted({c for cs in categories.values() for c in cs})
words=sorted(categories,key=lambda w:(-freq[w],w))
rows=[[w,[ids.index(c) for c in sorted(categories[w])]] for w in words]
out=Path('public/data');out.mkdir(parents=True,exist_ok=True)
d={'source':'Princeton WordNet 3.0 + function words','sourceUrl':'https://wordnet.princeton.edu/','categories':ids,'words':rows,'count':len(rows),'rankNote':'WordNet tagged usage frequency; not a modern conversational frequency ranking.'}
(out/'dictionary.json').write_text(json.dumps(d,separators=(',',':')))
(out/'words.txt').write_text('\n'.join(sorted(words))+'\n')
(out/'WORDNET-LICENSE.txt').write_bytes(z.read('wordnet/LICENSE'))
print(f'{len(rows):,} words; {len(ids)} categories; {(out/"dictionary.json").stat().st_size:,} bytes')
