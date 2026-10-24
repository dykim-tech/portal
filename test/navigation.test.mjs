import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedMenuIds, moveMenuId, visibleMenuIds } from '../public/navigation.js';

test('saved menu order keeps permitted items once and puts newly added menus after their default predecessor',()=>{
  const defaults=['dashboard','projects','users','settings'];
  assert.deepEqual(orderedMenuIds(defaults,['projects','missing','projects','dashboard']),['projects','users','dashboard','settings']);
  assert.deepEqual(orderedMenuIds(['dashboard','settings'],['users','settings']),['dashboard','settings']);
  // 사용자가 정한 순서는 유지하고 새 메뉴(outlook)만 설정 앞에 들어간다.
  assert.deepEqual(orderedMenuIds(['dashboard','work','tools','outlook','settings'],['work','dashboard','tools','settings']),['work','dashboard','tools','outlook','settings']);
  assert.deepEqual(orderedMenuIds(['dashboard','tools','outlook','settings'],['settings','tools','dashboard']),['settings','tools','outlook','dashboard']);
  // 새 메뉴는 기본 순서에서 바로 앞 메뉴 다음에 들어간다(회의록은 대시보드 다음).
  assert.deepEqual(orderedMenuIds(['dashboard','meetings','installations','settings'],['installations','dashboard','settings']),['installations','dashboard','meetings','settings']);
  // 앞 메뉴가 없으면 설정 앞에 넣는다.
  assert.deepEqual(orderedMenuIds(['meetings','dashboard','settings'],['dashboard','settings']),['dashboard','meetings','settings']);
  assert.deepEqual(orderedMenuIds(defaults,null),defaults);
});

test('menu move respects direction and list boundaries',()=>{
  const ids=['dashboard','projects','settings'];
  assert.deepEqual(moveMenuId(ids,'projects',-1),['projects','dashboard','settings']);
  assert.deepEqual(moveMenuId(ids,'projects',1),['dashboard','settings','projects']);
  assert.deepEqual(moveMenuId(ids,'dashboard',-1),ids);
  assert.deepEqual(moveMenuId(ids,'unknown',1),ids);
  assert.deepEqual(ids,['dashboard','projects','settings']);
});

test('hidden menus are skipped when showing and moving menus',()=>{
  const ids=['dashboard','meetings','drafts','tools','settings'];
  assert.deepEqual(visibleMenuIds(ids,['meetings','drafts']),['dashboard','tools','settings']);
  assert.deepEqual(visibleMenuIds(ids,['settings','tools']),['dashboard','meetings','drafts','settings'],'settings is always shown');
  assert.deepEqual(visibleMenuIds(ids,null),ids);
  const shown=visibleMenuIds(ids,['meetings','drafts']);
  // 보이는 메뉴끼리 자리를 바꾸고 숨긴 메뉴의 자리는 그대로 둔다.
  assert.deepEqual(moveMenuId(ids,'tools',-1,shown),['tools','meetings','drafts','dashboard','settings']);
  assert.deepEqual(moveMenuId(ids,'dashboard',-1,shown),ids);
  assert.deepEqual(moveMenuId(ids,'meetings',1,shown),ids,'a hidden menu cannot be moved from the visible list');
});
