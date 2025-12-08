# Sistema de Agentes - Documentação

## 📋 Visão Geral

O sistema de agentes permite criar assistentes de IA configuráveis com integração ao Kommo e workspace dedicado no N8N.

## 🗄️ Modelo de Dados (Prisma)

```prisma
model Agent {
  id          String   @id @default(cuid())
  userId      String

  // Etapa 1: Informações básicas
  name        String
  status      AgentStatus @default(DRAFT)
  prompt      String   @db.Text
  description String?  @db.Text

  // Etapa 2: Integração Kommo
  kommoEnabled      Boolean @default(false)
  kommoSubdomain    String?
  kommoAccessToken  String?
  kommodPipelineId  String?
  kommoConfig       Json?

  // Etapa 3: Credenciais vinculadas
  credentialIds     String[]

  // Etapa 4: Workspace N8N
  n8nWorkspaceId    String?  @unique
  n8nWorkspaceName  String?
  n8nWorkflowId     String?
  n8nWebhookUrl     String?
  n8nConfig         Json?

  // Metadados
  isActive          Boolean  @default(false)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}

enum AgentStatus {
  DRAFT           // Rascunho, ainda não finalizado
  PENDING_N8N     // Aguardando criação do workspace N8N
  ACTIVE          // Ativo e funcionando
  INACTIVE        // Inativo temporariamente
  ERROR           // Erro na configuração
}
```

## 🔌 API Endpoints

### Listar Agentes
```http
GET /agents
Authorization: Bearer {token}
```

**Resposta:**
```json
{
  "success": true,
  "message": "Agentes recuperados com sucesso",
  "data": [
    {
      "id": "cuid",
      "name": "Agente de Vendas",
      "status": "ACTIVE",
      "prompt": "Você é um assistente...",
      "isActive": true,
      "createdAt": "2025-01-17T...",
      "updatedAt": "2025-01-17T..."
    }
  ]
}
```

### Buscar Agente
```http
GET /agents/:id
Authorization: Bearer {token}
```

### Criar Agente
```http
POST /agents
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "Agente de Vendas",
  "prompt": "Você é um assistente de vendas...",
  "description": "Agente para atendimento de vendas",
  "status": "DRAFT",
  "kommoEnabled": true,
  "kommoSubdomain": "minhaempresa",
  "kommoAccessToken": "token_here",
  "kommodPipelineId": "12345",
  "credentialIds": ["cred_id_1", "cred_id_2"]
}
```

### Atualizar Agente
```http
PUT /agents/:id
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "Agente de Vendas Atualizado",
  "status": "ACTIVE"
}
```

### Deletar Agente
```http
DELETE /agents/:id
Authorization: Bearer {token}
```

### Criar Workspace N8N
```http
POST /agents/:id/create-workspace
Authorization: Bearer {token}
```

**Descrição:** Cria um workspace dedicado no N8N para o agente.

**Resposta:**
```json
{
  "success": true,
  "message": "Workspace N8N criado com sucesso",
  "data": {
    "id": "cuid",
    "name": "Agente de Vendas",
    "n8nWorkspaceId": "workspace_1234567890",
    "n8nWorkspaceName": "Agente de Vendas Workspace",
    "n8nWebhookUrl": "https://n8n.example.com/webhook/workspace_1234567890",
    "status": "ACTIVE",
    "isActive": true
  }
}
```

## 📝 Fluxo de Criação de Agente (Frontend)

### Etapa 1: Informações Básicas
- **Nome do Agente** (obrigatório)
- **Status** (DRAFT, ACTIVE, INACTIVE, ERROR)
- **Prompt** (obrigatório) - Instruções para o agente
- **Descrição** (opcional)

### Etapa 2: Integração Kommo
- **Habilitar Kommo** (toggle)
- **Subdomínio** - Subdomínio da conta Kommo
- **Access Token** - Token de autenticação
- **Pipeline ID** - ID do pipeline onde o agente atuará
- **Configurações Adicionais** (JSON opcional)

### Etapa 3: Vincular Credenciais
- Lista de credenciais disponíveis do usuário
- Seleção múltipla de credenciais
- Preview das credenciais selecionadas

### Etapa 4: Criar Workspace N8N
- Revisão das configurações
- Botão "Criar Workspace no N8N"
- Aguardar criação
- Receber URL do webhook e detalhes do workspace

## 🎨 Componentes Frontend

### Estrutura de Pastas
```
front-end-ia/
├── app/(dashboard)/agentes/
│   ├── page.tsx              # Listagem de agentes
│   └── novo/
│       └── page.tsx          # Formulário multi-etapas
├── components/agents/
│   ├── agent-list.tsx        # Tabela de agentes
│   ├── agent-form-step1.tsx  # Etapa 1: Informações
│   ├── agent-form-step2.tsx  # Etapa 2: Kommo
│   ├── agent-form-step3.tsx  # Etapa 3: Credenciais
│   └── agent-form-step4.tsx  # Etapa 4: N8N
├── types/agent.ts            # TypeScript types
└── lib/agents-api.ts         # API client functions
```

## 🔄 Estados do Agente

| Status | Descrição | Próxima Ação |
|--------|-----------|--------------|
| **DRAFT** | Rascunho, em criação | Continuar configuração |
| **PENDING_N8N** | Aguardando workspace N8N | Criar workspace |
| **ACTIVE** | Ativo e funcionando | Monitorar |
| **INACTIVE** | Inativo temporariamente | Reativar |
| **ERROR** | Erro na configuração | Corrigir configuração |

## 🔐 Segurança

- ✅ Autenticação obrigatória em todas as rotas
- ✅ Validação de propriedade (userId)
- ✅ Tokens sensíveis não são expostos nos logs
- ✅ Credenciais vinculadas verificadas antes de uso

## 🚀 Próximos Passos

1. Implementar lógica real de criação de workspace no N8N
2. Adicionar validações de credenciais
3. Implementar testes de integração com Kommo
4. Criar dashboard de métricas do agente
5. Adicionar logs de atividade do agente

## 📌 Notas Importantes

- Os agentes são criados com `status: DRAFT` por padrão
- O workspace N8N só é criado quando solicitado explicitamente
- As credenciais são armazenadas como array de IDs para referência
- Cada workspace N8N tem um webhook único
