# Vista previa del cierre anual

`annual-close-preview.js` define el elemento web `<annual-close-preview>`. Recibe el resultado de `AccountingService.previewAnnualClose()` (o su equivalente de API), muestra cada asiento con cuenta, glosa, Debe y Haber, y mantiene deshabilitada la confirmación mientras `canClose` sea `false`.

```html
<script type="module" src="/src/ui/annual-close-preview.js"></script>
<annual-close-preview id="annual-close"></annual-close-preview>
```

```js
const screen = document.querySelector("#annual-close");
const previewResponse = await fetch("/api/accounting/annual-close/preview", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ companyId, fiscalYear, generateNextYearOpening: true }),
});
if (!previewResponse.ok) throw new Error("No se pudo generar la vista previa");
screen.preview = await previewResponse.json();

screen.addEventListener("annual-close-confirm", async ({ detail }) => {
  // El endpoint vuelve a validar y rechaza revisiones desactualizadas.
  const response = await fetch("/api/accounting/annual-close/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(detail),
  });
  if (!response.ok) throw new Error("El cierre no se confirmó; actualiza la vista previa");
});
```

La API incluida en `src/api` vuelve a validar el ejercicio y compara `expectedRevision` al confirmar. No debe confiarse en `canClose` del navegador como validación final. El elemento es la capa visual reutilizable; una aplicación web debe alojarlo y llamar los endpoints del mismo origen.
