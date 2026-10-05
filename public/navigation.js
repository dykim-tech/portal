// 저장된 순서를 따르고, 저장 이후 새로 생긴 메뉴는 '설정' 바로 앞에(설정이 없으면 맨 뒤에) 넣는다.
export function orderedMenuIds(defaultIds, savedIds){
  if(!Array.isArray(savedIds))return [...defaultIds];
  const allowed=new Set(defaultIds),seen=new Set();
  const ordered=savedIds.filter(id=>allowed.has(id)&&!seen.has(id)&&seen.add(id));
  const added=defaultIds.filter(id=>!seen.has(id));
  const settings=ordered.indexOf('settings');
  if(settings<0)return [...ordered,...added];
  return [...ordered.slice(0,settings),...added,...ordered.slice(settings)];
}

export function moveMenuId(ids,id,direction){
  const from=ids.indexOf(id),to=from+direction;
  if(from<0||to<0||to>=ids.length)return [...ids];
  const next=[...ids];[next[from],next[to]]=[next[to],next[from]];
  return next;
}
