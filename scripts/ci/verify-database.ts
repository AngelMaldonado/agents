import { assertTestDatabase } from '../../server/src/test-database';
const url = process.env.AGENTS_TEST_DATABASE_URL;
if (!url) throw new Error('CI requiere AGENTS_TEST_DATABASE_URL: no se permite omitir los tests de integración.');
assertTestDatabase(url, process.env.AGENTS_DATABASE_URL ?? '');
