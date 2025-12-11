# Webhook RD Station CRM v2

## Objetivo

Implementar endpoint de webhook para receber eventos do RD Station CRM v2, permitindo sincronizar automaticamente alteracoes de negociacoes (deals) com os funis locais vinculados via `rdstationPipelineId`.

## Eventos Suportados

| Evento | Descricao | Acao Local |
|--------|-----------|------------|
| `crm_deal_created` | Negociacao criada no RD Station | Criar FunnelLead no funil vinculado |
| `crm_deal_updated` | Negociacao atualizada | Atualizar FunnelLead (nome, valor, stage, status) |
| `crm_deal_deleted` | Negociacao deletada | Deletar FunnelLead correspondente |
| `crm_lost_reason_created` | Motivo de perda criado | Log para auditoria |
| `crm_lost_reason_updated` | Motivo de perda atualizado | Log para auditoria |
| `crm_lost_reason_deleted` | Motivo de perda deletado | Log para auditoria |

## Links da Documentacao Oficial

- [Deal Created](https://developers.rdstation.com/reference/crm-v2-webhook-event-crm-deal-created)
- [Deal Updated](https://developers.rdstation.com/reference/crm-v2-webhook-event-crm-deal-updated)
- [Deal Deleted](https://developers.rdstation.com/reference/crm-v2-webhook-event-crm-deal-deleted)
- [Lost Reason Created](https://developers.rdstation.com/reference/crm-v2-webhook-event-crm-lost-reason-created)
- [Lost Reason Updated](https://developers.rdstation.com/reference/crm-v2-webhook-event-crm-lost-reason-updated)
- [Lost Reason Deleted](https://developers.rdstation.com/reference/crm-v2-webhook-event-crm-lost-reason-deleted)
- [Webhooks CRM Payload](https://developers.rdstation.com/reference/webhooks-payload-crm)
- [Webhook Service](https://developers.rdstation.com/reference/webhooks)

## Estrutura do Endpoint

### URL

```
POST /webhooks/rdstation-crm
```

### Headers Esperados

```
Content-Type: application/json
```

### Payload Padrao (Envelope)

Todos os webhooks do RD Station CRM seguem esta estrutura:

```json
{
  "event_name": "crm_deal_created | crm_deal_updated | crm_deal_deleted",
  "document": { ... },
  "event_timestamp": "2023-11-14T18:43:09.000Z",
  "transaction_uuid": "b2daa3cb-23b1-497f-afb5-a5e4acda9374"
}
```

## Payloads por Evento

### crm_deal_created / crm_deal_updated

```json
{
  "event_name": "crm_deal_created",
  "document": {
    "id": "64df7a11113f80018644923",
    "name": "Nome da Negociacao",
    "amount_monthly": 0,
    "amount_unique": 5000,
    "amount_total": 5000,
    "prediction_date": "2024-02-15",
    "created_at": "2024-01-10T14:30:00.000Z",
    "updated_at": "2024-01-10T14:30:00.000Z",
    "rating": 3,
    "status": "ongoing",
    "closed_at": null,
    "user": {
      "id": "user123",
      "name": "Vendedor",
      "email": "vendedor@empresa.com",
      "avatar_url": "https://..."
    },
    "deal_stage": {
      "id": "stage123",
      "name": "Proposta Enviada",
      "nickname": "Proposta",
      "order": 2
    },
    "deal_pipeline": {
      "id": "pipeline123",
      "name": "Pipeline Principal"
    },
    "deal_source": {
      "id": "source123",
      "name": "Website"
    },
    "campaign": {
      "id": "campaign123",
      "name": "Campanha Q1"
    },
    "deal_lost_reason": null,
    "deal_custom_fields": [
      {
        "value": "Valor customizado",
        "custom_field": {
          "id": "cf123",
          "label": "Campo Personalizado",
          "name": "campo_personalizado"
        }
      }
    ],
    "deal_products": [],
    "contacts": [
      {
        "id": "contact123",
        "name": "Cliente",
        "emails": [{"email": "cliente@email.com"}],
        "phones": [{"phone": "11999999999"}]
      }
    ]
  },
  "event_timestamp": "2024-01-10T14:30:00.000Z",
  "transaction_uuid": "uuid-unico"
}
```

### crm_deal_deleted

```json
{
  "event_name": "crm_deal_deleted",
  "document": {
    "id": "64df7a11113f80018644923",
    "name": "Teste Negociacao"
  },
  "event_timestamp": "2023-11-14T18:43:09.000Z",
  "transaction_uuid": "b2daa3cb-23b1-497f-afb5-a5e4acda9374"
}
```

### crm_lost_reason_* (created/updated/deleted)

```json
{
  "event_name": "crm_lost_reason_created",
  "document": {
    "id": "reason123",
    "name": "Preco muito alto"
  },
  "event_timestamp": "2024-01-10T14:30:00.000Z",
  "transaction_uuid": "uuid-unico"
}
```

## Mapeamento de Status

| RD Station Status | Acao Local |
|-------------------|------------|
| `ongoing` | Manter no stage mapeado |
| `won` | Mover para FunnelStage com `fixedType: "won"` |
| `lost` | Mover para FunnelStage com `fixedType: "lost"` |

## Logica de Sincronizacao

### Ao Receber crm_deal_created

1. Buscar `Funnel` onde `rdstationPipelineId === document.deal_pipeline.id`
2. Se encontrar, criar `FunnelLead`:
   - `name`: document.name
   - `value`: document.amount_total
   - `priority`: baseado em document.rating (1-2: low, 3: medium, 4-5: high)
   - `expectedCloseDate`: document.prediction_date
   - `source`: "RD Station CRM"
   - `notes`: "Sincronizado via webhook - Deal ID: {id}"
   - `stageId`: mapear document.deal_stage.id para FunnelStage local
3. Armazenar referencia: `rdstationDealId` no lead (campo a adicionar no schema)

### Ao Receber crm_deal_updated

1. Buscar `FunnelLead` onde `rdstationDealId === document.id`
2. Se encontrar, atualizar:
   - Campos basicos: name, value, expectedCloseDate, priority
   - Se status mudou para "won": mover para stage fixo won
   - Se status mudou para "lost": mover para stage fixo lost
   - Se deal_stage mudou: atualizar stageId (mapear para stage local)

### Ao Receber crm_deal_deleted

1. Buscar `FunnelLead` onde `rdstationDealId === document.id`
2. Se encontrar, deletar o lead

## Alteracoes Necessarias no Schema Prisma

```prisma
model FunnelLead {
  // ... campos existentes ...

  // Referencia ao deal do RD Station para sincronizacao bidirecional
  rdstationDealId String? @unique

  @@index([rdstationDealId])
}
```

## Implementacao Sugerida

### Arquivo: src/routes/webhooks/rdstation-crm/index.ts

```typescript
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { logError, logInfo } from "@/utils/logger";
import { formatResponse } from "@/utils/response-formatter";

// Schemas de validacao
const dealDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  amount_monthly: z.number().optional(),
  amount_unique: z.number().optional(),
  amount_total: z.number().optional(),
  prediction_date: z.string().nullable().optional(),
  rating: z.number().optional(),
  status: z.enum(["ongoing", "won", "lost"]).optional(),
  deal_stage: z.object({
    id: z.string(),
    name: z.string(),
    nickname: z.string().optional(),
    order: z.number().optional(),
  }).optional(),
  deal_pipeline: z.object({
    id: z.string(),
    name: z.string(),
  }).optional(),
  contacts: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    emails: z.array(z.object({ email: z.string() })).optional(),
    phones: z.array(z.object({ phone: z.string() })).optional(),
  })).optional(),
});

const webhookPayloadSchema = z.object({
  event_name: z.string(),
  document: z.union([dealDocumentSchema, z.object({ id: z.string(), name: z.string() })]),
  event_timestamp: z.string(),
  transaction_uuid: z.string(),
});

export default async function (fastify: FastifyInstance) {
  fastify.post("/", async (request, reply) => {
    try {
      const payload = webhookPayloadSchema.parse(request.body);

      logInfo("RD Station CRM webhook received", {
        event: payload.event_name,
        dealId: payload.document.id,
        transactionId: payload.transaction_uuid,
      });

      switch (payload.event_name) {
        case "crm_deal_created":
          await handleDealCreated(payload);
          break;
        case "crm_deal_updated":
          await handleDealUpdated(payload);
          break;
        case "crm_deal_deleted":
          await handleDealDeleted(payload);
          break;
        case "crm_lost_reason_created":
        case "crm_lost_reason_updated":
        case "crm_lost_reason_deleted":
          logInfo("Lost reason event received", { event: payload.event_name, document: payload.document });
          break;
        default:
          logInfo("Unknown webhook event", { event: payload.event_name });
      }

      return formatResponse({ message: "Webhook processed" });
    } catch (error: any) {
      logError("Error processing RD Station webhook", error);
      return reply.code(500).send(formatResponse({ success: false, error: "Webhook processing failed" }));
    }
  });
}

// Handlers implementados separadamente
async function handleDealCreated(payload: any) { /* ... */ }
async function handleDealUpdated(payload: any) { /* ... */ }
async function handleDealDeleted(payload: any) { /* ... */ }
```

## Registro da Rota no Server

Em `src/server.ts`, adicionar:

```typescript
app.register(import('./routes/webhooks/rdstation-crm'), { prefix: '/webhooks/rdstation-crm' });
```

## Configuracao no RD Station

1. Acessar Configuracoes > Integracoes > Webhooks no RD Station CRM
2. Criar novo webhook com:
   - URL: `https://seu-dominio.com/webhooks/rdstation-crm`
   - Metodo: POST
   - Eventos: crm_deal_created, crm_deal_updated, crm_deal_deleted
3. Testar a conexao

## Consideracoes de Seguranca

1. **Validacao de Origem**: Implementar verificacao de IP ou secret header
2. **Rate Limiting**: Aplicar limite de requisicoes
3. **Idempotencia**: Usar `transaction_uuid` para evitar processamento duplicado
4. **Logs de Auditoria**: Registrar todos os eventos para debug

## Proximos Passos

- [ ] Adicionar campo `rdstationDealId` ao schema Prisma
- [ ] Criar rota `/webhooks/rdstation-crm`
- [ ] Implementar handlers para cada evento
- [ ] Implementar mapeamento de stages (RD Station → Local)
- [ ] Adicionar tabela de log para auditoria de webhooks
- [ ] Configurar webhook no painel do RD Station
- [ ] Testar sincronizacao bidirecional
