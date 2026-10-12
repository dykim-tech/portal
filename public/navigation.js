// 저장된 순서를 따르고, 저장 이후 새로 생긴 메뉴는 기본 순서에서 바로 앞에 있는 메뉴 다음에 넣는다
// (예: 회의록은 대시보드 다음). 앞 메뉴가 없으면 '설정' 바로 앞에(설정이 없으면 맨 뒤에) 넣는다.
export function orderedMenuIds(defaultIds, savedIds){
  if(!Array.isArray(savedIds))return [...defaultIds];
  const allowed=new Set(defaultIds),seen=new Set();
  const ordered=savedIds.filter(id=>allowed.has(id)&&!seen.has(id)&&seen.add(id));
  defaultIds.forEach((id,index)=>{
    if(seen.has(id))return;
    seen.add(id);
    if(id==='settings'){ordered.push(id);return;}
    const before=index>0?ordered.indexOf(defaultIds[index-1]):-1;
    if(before>=0){ordered.splice(before+1,0,id);return;}
    const settings=ordered.indexOf('settings');
    if(settings<0)ordered.push(id);else ordered.splice(settings,0,id);
  });
  return ordered;
}

export function moveMenuId(ids,id,direction){
  const from=ids.indexOf(id),to=from+direction;
  if(from<0||to<0||to>=ids.length)return [...ids];
  const next=[...ids];[next[from],next[to]]=[next[to],next[from]];
  return next;
}
