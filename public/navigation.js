export function orderedMenuIds(defaultIds, savedIds){
  if(!Array.isArray(savedIds))return [...defaultIds];
  const allowed=new Set(defaultIds),seen=new Set();
  return [...savedIds,...defaultIds].filter(id=>allowed.has(id)&&!seen.has(id)&&seen.add(id));
}

export function moveMenuId(ids,id,direction){
  const from=ids.indexOf(id),to=from+direction;
  if(from<0||to<0||to>=ids.length)return [...ids];
  const next=[...ids];[next[from],next[to]]=[next[to],next[from]];
  return next;
}
