#!/usr/bin/env python3
"""Convert installed Microsoft Windows ADMX/ADML XML metadata into a searchable catalogue.
Source: Microsoft Windows 11 25H2 V2 administrative template package.
This creates UI discovery metadata only; it does not enable deployment of any policy.
"""
import json, re, pathlib, sys, os, collections, xml.etree.ElementTree as ET

source=pathlib.Path(sys.argv[1])
destination=pathlib.Path(sys.argv[2])
admx_files=sorted(source.glob('*.admx'))
if not admx_files:
    raise SystemExit('No ADMX files found: '+str(source))

def local(element):
    return element.tag.split('}')[-1]
def child(item, tag):
    return next((x for x in (item if item is not None else []) if local(x)==tag),None)
def children(item, tag):
    return [x for x in (item if item is not None else []) if local(x)==tag]
def attr(item,name,default=''):
    return item.attrib.get(name,default) if item is not None else default
def localized(value,strings):
    key=re.fullmatch(r'\$\(string\.([^)]+)\)',value or '')
    return strings.get(key.group(1),key.group(1)) if key else (value or '')
def clean(value,limit=500):
    return ' '.join((value or '').split())[:limit]

categories={}
files=[]
warnings=[]
for f in admx_files:
    try:
        root=ET.parse(f).getroot()
    except LookupError:
        value=f.read_bytes().decode('utf-16')
        value=re.sub(r'encoding=[\"\']unicode[\"\']', 'encoding=\"utf-8\"', value, flags=re.I)
        root=ET.fromstring(value)
    except ET.ParseError as exc:
        warnings.append({'file':f.name,'error':str(exc)})
        continue
    adml=next((p for p in (source/'en-US').glob('*.adml') if p.stem.lower()==f.stem.lower()),None)
    strings={}
    if adml:
        try:
            for el in ET.parse(adml).getroot().iter():
                if local(el)=='string' and el.get('id'):
                    strings[el.get('id')]=''.join(el.itertext())
        except ET.ParseError:
            pass
    ns=child(root,'policyNamespaces')
    target=child(ns,'target')
    namespace=attr(target,'namespace',f.stem)
    alias={'':namespace}
    for u in children(ns,'using'):
        alias[attr(u,'prefix')]=attr(u,'namespace')
    def normalize(ref):
        if not ref: return ''
        if ':' in ref:
            prefix,name=ref.split(':',1)
            return alias.get(prefix,prefix)+':'+name
        return namespace+':'+ref
    group=child(root,'categories')
    for cat in children(group,'category'):
        parent=child(cat,'parentCategory')
        categories[normalize(attr(cat,'name'))]={
            'name':clean(localized(attr(cat,'displayName'),strings),140),
            'parent':normalize(attr(parent,'ref')),
        }
    files.append((f,root,strings,namespace,normalize))

def path_for(ref,fallback):
    parts=[]
    seen=set()
    while ref and ref not in seen and len(parts)<15:
        seen.add(ref)
        cat=categories.get(ref)
        if not cat:
            break
        if cat['name'] and cat['name'] not in parts:
            parts.append(cat['name'])
        ref=cat['parent']
    return list(reversed(parts)) or [fallback]

policies=[]
seen=set()
for f,root,strings,namespace,normalize in files:
    for policy in children(child(root,'policies'),'policy'):
        name=attr(policy,'name')
        if not name:continue
        key='admx:'+f.stem.lower()+':'+name
        if key.lower() in seen: continue
        seen.add(key.lower())
        parent=child(policy,'parentCategory')
        path=path_for(normalize(attr(parent,'ref')),f.stem)
        label=clean(localized(attr(policy,'displayName'),strings),220)
        desc=clean(localized(attr(policy,'explainText'),strings),800)
        elements=[]
        for e in children(child(policy,'elements'),'enum')+children(child(policy,'elements'),'decimal')+children(child(policy,'elements'),'text')+children(child(policy,'elements'),'boolean')+children(child(policy,'elements'),'list')+children(child(policy,'elements'),'multiText')+children(child(policy,'elements'),'longDecimal'):
            typ=local(e)
            item={'id':attr(e,'id'),'type':typ,'valueName':attr(e,'valueName')}
            for n in ['minValue','maxValue','maxLength','required','minLength']:
                if n in e.attrib:item[n]=attr(e,n)
            if typ=='enum':
                item['options']=[
                    {'label':clean(localized(attr(opt,'displayName'),strings),130),'value':next((attr(c,'value') for c in v.iter() if local(c)=='decimal' or local(c)=='string'),'') if (v:=child(opt,'value')) is not None else ''}
                    for opt in children(e,'item')
                ]
            elements.append(item)
        support=child(policy,'supportedOn')
        scope=attr(policy,'class','Machine')
        value_name=attr(policy,'valueName')
        category=path[0]
        item={
          'id':key,'name':label or name,'path':' / '.join(path),'category':category,
          'description':desc,'scope':'device' if scope=='Machine' else ('user' if scope=='User' else 'both'),
          'source':os.getenv('H5C_ADMX_SOURCE','Microsoft Windows 11 25H2 ADMX V2'),
          'sourceFile':f.name,'policyName':name,'namespace':namespace,
          'supportedOn':attr(support,'ref'),'registryKey':attr(policy,'key'),'valueName':value_name,
          'type':'boolean' if not elements else ('compound' if len(elements)>1 else elements[0]['type']),
          'elements':elements,'managementStatus':'catalogue_only',
        }
        policies.append(item)
policies.sort(key=lambda p:(p['category'].lower(),p['name'].lower(),p['id']))
cats=collections.Counter(p['category'] for p in policies)
result={
 'schemaVersion':1,'source':'Microsoft Windows 11 ADMX/ADML',
 'sourceVersion':os.getenv('H5C_ADMX_VERSION','Windows 11 25H2 V2 (27 October 2025)'),
 'downloadPage':os.getenv('H5C_ADMX_DOWNLOAD_PAGE','https://www.microsoft.com/en-us/download/details.aspx?id=108428'),
 'importedPolicyCount':len(policies),'sourceFiles':len(files),
 'note':'Catalogued for discovery only. Import does not imply management, enforcement, OS compatibility or baseline recommendation.',
 'categories':[{'name':name,'count':count} for name,count in cats.most_common()],
 'settings':policies,
}
destination.parent.mkdir(parents=True,exist_ok=True)
destination.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
print(json.dumps({'policies':len(policies),'categories':len(cats),'files':len(files),
                  'bytes':destination.stat().st_size,'warnings':warnings[:6],
                  'examples':[x['name'] for x in policies[:5]]},indent=2))
