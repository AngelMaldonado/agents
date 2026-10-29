// Fail closed BEFORE migrations/TRUNCATE. Setting process.env after importing db
// cannot retarget an existing Pool; verify the captured URL and the actual connection.
export function assertTestDatabase(expected: string, configured: string, actualName?: string) {
 let target: URL, active: URL;
 try { target = new URL(expected); active = new URL(configured); }
 catch { throw new Error('Las pruebas requieren una URL de base de pruebas válida.'); }
 const name = target.pathname.slice(1);
 if (!name.endsWith('_test') || target.href !== active.href || (actualName !== undefined && actualName !== name)) {
  throw new Error('Pruebas abortadas: la conexión no corresponde a la base _test explícita. No se permite modificar dev ni producción.');
 }
}
