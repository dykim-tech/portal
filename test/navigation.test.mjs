import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedMenuIds, moveMenuId } from '../public/navigation.js';

test('saved menu order keeps permitted items once and puts newly added menus before settings',()=>{
  const defaults=['dashboard','projects','users','settings'];
  assert.deepEqual(orderedMenuIds(defaults,['projects','missing','projects','dashboard']),['projects','dashboard','users','settings']);
  assert.deepEqual(orderedMenuIds(['dashboard','settings'],['users','settings']),['dashboard','settings']);
  // 사용자가 정한 순서는 유지하고 새 메뉴(outlook)만 설정 앞에 들어간다.
  assert.deepEqual(orderedMenuIds(['dashboard','work','tools','outlook','settings'],['work','dashboard','tools','settings']),['work','dashboard','tools','outlook','settings']);
  assert.deepEqual(orderedMenuIds(['dashboard','tools','outlook','settings'],['settings','tools','dashboard']),['outlook','settings','tools','dashboard']);
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
