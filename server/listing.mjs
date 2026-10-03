const fail = message => Object.assign(new Error(message), { status: 400 });

export const PAGE_SIZES = [25, 50, 70, 100];

export function listing(query, columns, defaultSort, defaultDirection = 'desc', tieBreak = 'id') {
  const page = Number(query.page ?? 1);
  const size = Number(query.page_size ?? 50);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw fail('페이지를 확인해 주세요.');
  if (!PAGE_SIZES.includes(size)) throw fail('페이지당 표시 건수를 확인해 주세요.');
  const sort = query.sort ?? defaultSort;
  if (typeof sort !== 'string' || !Object.hasOwn(columns, sort)) throw fail('정렬 항목을 확인해 주세요.');
  const direction = query.direction ?? (sort === defaultSort ? defaultDirection : 'asc');
  if (!['asc', 'desc'].includes(direction)) throw fail('정렬 방향을 확인해 주세요.');
  return {
    page, size, sort, direction,
    orderBy: `${columns[sort]} ${direction.toUpperCase()}, ${tieBreak} DESC`
  };
}
