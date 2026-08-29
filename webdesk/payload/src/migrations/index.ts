import * as migration_20260829_113056_wsk_initial from './20260829_113056_wsk_initial';

export const migrations = [
  {
    up: migration_20260829_113056_wsk_initial.up,
    down: migration_20260829_113056_wsk_initial.down,
    name: '20260829_113056_wsk_initial'
  },
];
