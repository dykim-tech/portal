import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedMenuIds, moveMenuId } from '../public/navigation.js';

test('saved menu order keeps permitted items once and appends newly added menus',()=>{
  const defaults=['dashboard','projects','users','settings'];
  assert.deepEqual(orderedMenuIds(defaults,['projects','missing','projects','dashboard']),['projects','dashboard','users','settings']);
  assert.deepEqual(orderedMenuIds(['dashboard','settings'],['users','settings']),['settings','dashboard']);
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
