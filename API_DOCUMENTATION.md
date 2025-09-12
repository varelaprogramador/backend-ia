# 📚 Documentação Completa da API - CRUD Routes

Esta documentação detalha todas as rotas CRUD criadas para o sistema, baseadas no schema Prisma.

## 📋 Sumário
- [Users](#users)
- [N8N Chat Memory](#n8n-chat-memory)
- [Blocked Contacts](#blocked-contacts)
- [My Messages](#my-messages)
- [Credenciais Evolution API](#credenciais-evolution-api)
- [Configurações IA](#configurações-ia)
- [Padrões de Resposta](#padrões-de-resposta)

---

## 👥 Users

### **GET /users**
Lista todos os usuários com paginação e filtros

**Query Parameters:**
- `page` (string, default: "1") - Página atual
- `limit` (string, default: "10") - Itens por página
- `search` (string, opcional) - Busca por nome, username ou email
- `banned` (string, opcional) - Filtrar usuários banidos ("true"/"false")
- `locked` (string, opcional) - Filtrar usuários bloqueados ("true"/"false")

**Exemplo de Resposta:**
```json
{
  "success": true,
  "data": [
    {
      "id": "user_123",
      "firstName": "João",
      "lastName": "Silva",
      "username": "joao.silva",
      "primaryEmailId": "joao@email.com",
      "banned": false,
      "locked": false,
      "createdAt": "2024-01-15T10:30:00Z",
      "_count": {
        "credenciaisEvos": 2,
        "configIAs": 3,
        "blockedContacts": 1
      }
    }
  ],
  "metadata": {
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 50,
      "totalPages": 5,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### **GET /users/:id**
Obtém um usuário específico por ID

**Response:** Retorna todos os dados do usuário incluindo relacionamentos (credenciaisEvos, configIAs, blockedContacts)

### **POST /users**
Cria um novo usuário

**Body Parameters:**
```json
{
  "id": "user_123", // Obrigatório
  "firstName": "João",
  "lastName": "Silva",
  "username": "joao.silva",
  "primaryEmailId": "joao@email.com",
  "banned": false,
  "locked": false
}
```

### **PUT /users/:id**
Atualiza um usuário existente

**Body:** Mesmos campos do POST, exceto `id` (todos opcionais)

### **DELETE /users/:id**
Remove um usuário

**Cascata:** Remove automaticamente todos os relacionamentos (credenciais, configurações IA, contatos bloqueados)

---

## 💬 N8N Chat Memory

Sistema de memória de conversação para integração com N8N e Evolution API.

### **GET /n8n-chat-memory**
Lista registros de chat memory com filtros avançados

**Query Parameters:**
- `page`, `limit` - Paginação padrão
- `sessionId` (string) - Filtrar por sessão específica
- `direction` ("input"|"output") - Tipo de mensagem
- `chatId` (string) - ID do chat WhatsApp
- `senderId` (string) - ID do remetente
- `instanceName` (string) - Nome da instância Evolution API
- `messageType` (string) - Tipo da mensagem
- `processed` ("true"|"false") - Se foi processada pela IA
- `isGroup` ("true"|"false") - Se é mensagem de grupo
- `dateFrom` (datetime) - Data inicial
- `dateTo` (datetime) - Data final

### **GET /n8n-chat-memory/session/:sessionId**
Obtém todo histórico de uma sessão específica

**Query Parameters:**
- `limit` (default: 100) - Limite de mensagens
- `direction` ("input"|"output") - Filtrar por direção

**Uso:** Recuperar contexto completo de uma conversa para IA

### **POST /n8n-chat-memory**
Cria novo registro de chat memory

**Body Obrigatório:**
```json
{
  "sessionId": "session_123",
  "message": "Olá, como posso ajudar?",
  "direction": "input"
}
```

**Body Completo (Evolution API):**
```json
{
  "sessionId": "session_123",
  "message": "Olá, como posso ajudar?",
  "direction": "input",
  "messageId": "msg_456",
  "instanceName": "instance1",
  "chatId": "5511999999999@s.whatsapp.net",
  "senderId": "5511888888888@s.whatsapp.net",
  "senderName": "João Silva",
  "messageType": "text",
  "content": "Texto da mensagem",
  "mediaUrl": "https://url-da-midia.com/arquivo.jpg",
  "mediaType": "image",
  "timestamp": "2024-01-15T10:30:00Z",
  "isGroup": false,
  "processed": false,
  "action": "respond",
  "system_message": "Você é um assistente útil"
}
```

### **DELETE /n8n-chat-memory/session/:sessionId**
Remove todo histórico de uma sessão

**Uso:** Limpar memória de conversação quando necessário

---

## 🚫 Blocked Contacts

Sistema de bloqueio de contatos WhatsApp por usuário.

### **GET /blocked-contacts**
Lista contatos bloqueados com informações do usuário

**Inclui:** Dados do usuário que bloqueou (firstName, lastName, username, email)

### **GET /blocked-contacts/user/:userId**
Lista contatos bloqueados por um usuário específico

### **GET /blocked-contacts/check/:remoteJid**
Verifica se um número WhatsApp está bloqueado

**Response:**
```json
{
  "success": true,
  "data": {
    "blocked": true,
    "contact": {
      "id": "block_123",
      "remoteJid": "5511999999999@s.whatsapp.net",
      "reason": "Spam",
      "blockedBy": "Sistema",
      "user": {...}
    }
  }
}
```

### **POST /blocked-contacts**
Bloqueia um novo contato

**Body:**
```json
{
  "userId": "user_123",
  "remoteJid": "5511999999999@s.whatsapp.net",
  "reason": "Spam",
  "blockedBy": "João Silva"
}
```

### **DELETE /blocked-contacts/jid/:remoteJid**
Desbloqueia contato pelo número WhatsApp

**Uso:** Endpoint direto para desbloquear sem precisar do ID interno

---

## 📱 My Messages

Sistema de armazenamento de mensagens enviadas e recebidas via Evolution API.

### **GET /my-messages**
Lista mensagens com filtros avançados

**Filtros Únicos:**
- `isAiResponse` - Identifica respostas geradas por IA
- `direction` ("sent"|"received") - Mensagens enviadas vs recebidas

### **GET /my-messages/chat/:chatId**
Obtém histórico de um chat específico

**Uso:** Visualizar conversa completa de um chat WhatsApp

### **GET /my-messages/stats/session/:sessionId**
Estatísticas detalhadas de uma sessão

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "session_123",
    "totalMessages": 150,
    "sentMessages": 75,
    "receivedMessages": 75,
    "aiResponses": 30,
    "groupMessages": 20,
    "mediaMessages": 15,
    "privateMessages": 130,
    "textMessages": 135
  }
}
```

### **POST /my-messages**
Registra nova mensagem

**Campos Especiais:**
- `aiResponse` (string) - Conteúdo da resposta da IA
- `isAiResponse` (boolean) - Marca se é resposta automática
- `direction` ("sent"|"received") - Direção da mensagem

---

## 🔐 Credenciais Evolution API

Gerenciamento seguro de credenciais para integração com Evolution API.

### **Segurança Implementada:**
- **Mascaramento de API Keys:** Exibe apenas primeiros e últimos 4 caracteres
- **Endpoint RAW separado:** Para acesso interno às credenciais completas
- **Logs de acesso:** Registra quando credenciais são acessadas

### **GET /credenciais-evo**
Lista credenciais (API keys mascaradas por segurança)

**Response Example:**
```json
{
  "success": true,
  "data": [
    {
      "id": "cred_123",
      "userId": "user_123",
      "baseUrl": "https://api.evolution.com.br",
      "user": {
        "firstName": "João",
        "lastName": "Silva"
      }
    }
  ]
}
```

### **GET /credenciais-evo/:id**
Obtém credencial específica (API key mascarada)

### **GET /credenciais-evo/:id/raw**
**⚠️ USO INTERNO APENAS** - Obtém credenciais completas

**Log de Segurança:** Registra IP e usuário que acessou

### **POST /credenciais-evo/:id/test**
Testa conectividade com Evolution API

**Status:** Atualmente retorna estrutura para implementação futura

### **POST /credenciais-evo**
Cria novas credenciais

**Validações:**
- Verifica se usuário existe
- Valida formato da URL base
- API key obrigatória

---

## 🤖 Configurações IA

Sistema de gerenciamento de configurações de IA por usuário.

### **GET /config-ia/active/user/:userId**
Obtém apenas configurações ativas de um usuário

**Filtro:** `status = "ativo"`

### **PATCH /config-ia/:id/status**
Atualiza apenas o status de uma configuração

**Body:**
```json
{
  "status": "ativo" // ou "inativo", "pausado", etc.
}
```

### **POST /config-ia/:id/clone**
Clona uma configuração existente

**Body:**
```json
{
  "nome": "Cópia da Configuração Original"
}
```

**Comportamento:**
- Copia todos os campos da configuração original
- Define status como "inativo" por padrão
- Gera novo ID automaticamente

### **POST /config-ia**
Cria nova configuração de IA

**Body Obrigatório:**
```json
{
  "userId": "user_123",
  "nome": "Assistente de Vendas",
  "prompt": "Você é um especialista em vendas..."
}
```

**Body Completo:**
```json
{
  "userId": "user_123",
  "nome": "Assistente de Vendas",
  "prompt": "Você é um especialista em vendas que ajuda clientes a encontrar produtos ideais...",
  "status": "ativo",
  "webhookUrlProd": "https://webhook-prod.com/ai-response",
  "webhookUrlDev": "https://webhook-dev.com/ai-response"
}
```

---

## 📊 Padrões de Resposta

### **Resposta de Sucesso:**
```json
{
  "success": true,
  "message": "Operação realizada com sucesso",
  "data": { /* dados retornados */ },
  "metadata": {
    "pagination": { /* info de paginação */ },
    "additional": "metadados extras"
  }
}
```

### **Resposta de Erro:**
```json
{
  "success": false,
  "error": "Tipo do erro",
  "message": "Descrição detalhada do erro"
}
```

### **Códigos de Status HTTP:**
- `200` - OK (GET, PUT, PATCH)
- `201` - Created (POST)
- `400` - Bad Request (dados inválidos)
- `401` - Unauthorized (não autenticado)
- `403` - Forbidden (não autorizado)
- `404` - Not Found (recurso não encontrado)
- `409` - Conflict (duplicação/conflito)
- `500` - Internal Server Error

### **Tratamento de Erros Prisma:**
- `P2002` - Violação de constraint único → 409 Conflict
- `P2025` - Registro não encontrado → 404 Not Found

---

## 🔍 Funcionalidades Avançadas

### **Paginação Padrão:**
- Page: 1 (primeira página)
- Limit: 10 itens por página
- Metadata inclui: total, totalPages, hasNext, hasPrev

### **Busca e Filtros:**
- **Users:** Busca por nome, sobrenome, username, email
- **Blocked Contacts:** Busca por JID, motivo, responsável pelo bloqueio
- **N8N Chat Memory:** Filtros por sessão, chat, remetente, tipo, data
- **My Messages:** Filtros por direção, tipo, IA, grupo
- **Config IA:** Busca por nome, prompt, dados do usuário

### **Relacionamentos:**
- **Users:** Inclui contagens de credenciais, configurações IA, contatos bloqueados
- **Blocked Contacts:** Inclui dados básicos do usuário
- **Credenciais Evo:** Inclui dados básicos do usuário
- **Config IA:** Inclui dados básicos do usuário

### **Endpoints Especiais:**
- **Session Management:** Limpeza de sessões completas
- **Statistics:** Estatísticas detalhadas de mensagens
- **Security Checks:** Verificação de bloqueios
- **Testing:** Teste de conectividade de APIs
- **Cloning:** Duplicação de configurações

---

## 🛡️ Segurança

### **Sanitização de Dados:**
- Validação com Zod schemas
- Sanitização automática de strings
- Mascaramento de dados sensíveis

### **Logging:**
- Log de todas as operações CRUD
- Log de acessos a credenciais sensíveis
- Log de erros com contexto

### **Headers de Segurança:**
- Implementados via middleware do Fastify
- CSP, HSTS, X-Frame-Options configurados

---

Esta documentação cobre todas as rotas CRUD implementadas. Cada endpoint segue padrões REST e inclui validação, tratamento de erro, logging e documentação OpenAPI/Swagger integrada.