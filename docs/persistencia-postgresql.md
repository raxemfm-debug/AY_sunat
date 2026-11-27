# Persistencia en PostgreSQL

La capa `src/database` guarda de forma permanente lo emitido, las compras y la contabilidad.
Sin `DATABASE_URL` (solo fuera de producción) usa repositorios en memoria con las mismas reglas.

## Qué se guarda y dónde

| Dato | Repositorio | Tablas |
| --- | --- | --- |
| Empresas y series | `PostgresCompanyRepository` | `companies`, `document_series` |
| Comprobantes emitidos y CDR | `PostgresCpeRepository` | `cpe_documents`, `cpe_items` |
| Compras (RCE/SIRE) y proveedores | `PostgresPurchaseRepository` | `private.purchase_*` |
| Libro Diario y cierres mensuales | `PostgresAccountingLedgerRepository` | `private.accounting_*` |

## Uso

```ts
import { createPersistence } from './database/index.js';
import { CpeEmissionOrchestrator } from './modules/cpe/index.js';
import { PersistentPurchaseService } from './modules/purchases/index.js';
import { PersistentAccountingService } from './modules/accounting/index.js';

const db = createPersistence({ databaseUrl: process.env.DATABASE_URL });
const emision = new CpeEmissionOrchestrator({ companyRepo: db.companies, cpeRepo: db.cpe });
const compras = new PersistentPurchaseService(db.purchases);
const contabilidad = new PersistentAccountingService(db.ledger);
// ...
await db.close();
```

## Garantías

- Correlativos de serie atómicos: dos emisiones simultáneas nunca reciben el mismo número.
- Comprobante de compra único por empresa y CAR (restricción en base de datos, no solo en memoria).
- Asientos numerados sin huecos por período; el bloqueo de período o ejercicio cerrado se verifica
  dentro de la transacción, aunque se escriba directo al repositorio.
- Un cierre mensual calculado con datos desactualizados se rechaza (`ConcurrentPeriodChangeError`).
- Montos en `NUMERIC`, leídos como texto: no hay pérdida de precisión por `float`.

## Migraciones

Aplicar en orden las de `supabase/migrations/` (local: `npx supabase db reset`; remoto: `npx supabase db push`).

- `20261126000100_purchases_and_period_audit.sql`: compras y auditoría de reapertura de períodos.
- `20261126000200_fix_accounting_revision_trigger.sql`: corrige el trigger que impedía insertar asientos.

## Pruebas de integración

```bash
npx supabase start                 # Postgres local en el puerto 54322
# PowerShell:
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
npm run test:db
```

Las pruebas crean una base temporal, aplican todas las migraciones y la eliminan al terminar.
Sin `TEST_DATABASE_URL`, `npm test` las marca como omitidas.
