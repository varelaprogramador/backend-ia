# Configuração de Credenciais Evolution API

## Visão Geral

O sistema suporta dois modos de operação para as credenciais do Evolution API:

1. **Credenciais Padrão do Ambiente**: Usadas quando não são fornecidas credenciais específicas
2. **Credenciais Personalizadas**: Específicas para cada instância

## Configuração das Credenciais Padrão

### Passo 1: Configurar Variáveis de Ambiente

Adicione as seguintes variáveis ao arquivo `.env`:

```env
# Credenciais padrão do Evolution API (usadas quando não houver credenciais personalizadas)
DEFAULT_EVOLUTION_URL="https://evolution.exemplo.com"
DEFAULT_EVOLUTION_API_KEY="sua-chave-api-padrao"
```

### Passo 2: Valores Recomendados

- **DEFAULT_EVOLUTION_URL**: URL completa do servidor Evolution API (sem trailing slash)
  - Exemplo: `https://evolution.exemplo.com`
  - Exemplo: `http://localhost:8080`

- **DEFAULT_EVOLUTION_API_KEY**: Chave de API global do Evolution
  - Obtenha esta chave no painel administrativo do Evolution API
  - Mantenha esta chave em segredo e não compartilhe

## Como Funciona

### Criação de Instância

#### Com Credenciais Padrão (Checkbox Desmarcado)
```json
{
  "instanceName": "MinhaInstancia",
  "serverUrl": "",
  "apiKey": "",
  "webhookUrl": "https://meu-servidor.com/webhooks/receive-evo"
}
```
→ Backend usa `DEFAULT_EVOLUTION_URL` e `DEFAULT_EVOLUTION_API_KEY`

#### Com Credenciais Personalizadas (Checkbox Marcado)
```json
{
  "instanceName": "MinhaInstancia",
  "serverUrl": "https://meu-evolution-custom.com",
  "apiKey": "minha-chave-personalizada",
  "webhookUrl": "https://meu-servidor.com/webhooks/receive-evo"
}
```
→ Backend usa as credenciais fornecidas

### Atualização de Instância

O mesmo comportamento se aplica:
- Campos vazios → Usa credenciais do ambiente
- Campos preenchidos → Usa credenciais fornecidas

### Geração de QR Code

O sistema automaticamente:
1. Verifica se a instância tem credenciais específicas
2. Se não tiver, usa as credenciais padrão do `.env`
3. Conecta ao Evolution API com as credenciais apropriadas
4. Gera e retorna o QR Code

## Segurança

### Boas Práticas

1. **Nunca commite o arquivo `.env`**: Mantenha-o no `.gitignore`
2. **Use HTTPS**: Sempre use URLs HTTPS em produção
3. **Rotação de Chaves**: Altere as chaves API periodicamente
4. **Credenciais Personalizadas**: Use para isolar diferentes clientes ou ambientes

### Hierarquia de Credenciais

```
Credenciais da Instância (Banco de Dados)
    ↓ (se vazio)
Credenciais Padrão do Ambiente (.env)
    ↓ (se vazio)
Erro: Nenhuma credencial disponível
```

## Logs e Debugging

O backend registra logs informativos sobre qual tipo de credencial está sendo usado:

```
🔑 [CREATE INSTANCE] Credenciais utilizadas: {
  serverUrl: 'Presente',
  apiKey: 'Presente',
  isDefault: true
}
```

- `isDefault: true` → Usando credenciais do ambiente
- `isDefault: false` → Usando credenciais específicas da instância

## Troubleshooting

### Problema: "Instância não possui configurações válidas"

**Causa**: Nenhuma credencial disponível (nem no banco, nem no `.env`)

**Solução**:
1. Configure as variáveis `DEFAULT_EVOLUTION_URL` e `DEFAULT_EVOLUTION_API_KEY` no `.env`
2. Ou forneça credenciais personalizadas ao criar a instância

### Problema: "Servidor Evolution API não está acessível"

**Causa**: URL inválida ou servidor offline

**Solução**:
1. Verifique se a URL está correta
2. Teste a conectividade: `curl https://evolution.exemplo.com/`
3. Verifique se o servidor Evolution está rodando

### Problema: "Erro ao criar instância no Evolution API"

**Causa**: Chave API inválida ou sem permissões

**Solução**:
1. Verifique se a chave API está correta
2. Confirme que a chave tem permissões para criar instâncias
3. Verifique os logs do Evolution API para mais detalhes

## Exemplos de Uso

### Exemplo 1: Ambiente de Desenvolvimento (Credenciais Padrão)

```env
DEFAULT_EVOLUTION_URL="http://localhost:8080"
DEFAULT_EVOLUTION_API_KEY="dev-api-key-123"
```

Todas as instâncias criadas sem credenciais personalizadas usarão o Evolution local.

### Exemplo 2: Produção Multi-Tenant

```env
DEFAULT_EVOLUTION_URL="https://evolution-prod.empresa.com"
DEFAULT_EVOLUTION_API_KEY="prod-global-key-456"
```

- Instâncias padrão: Usam servidor de produção compartilhado
- Clientes VIP: Podem ter credenciais personalizadas para servidores dedicados

### Exemplo 3: Ambiente Híbrido

```env
DEFAULT_EVOLUTION_URL="https://evolution-shared.empresa.com"
DEFAULT_EVOLUTION_API_KEY="shared-key-789"
```

- 90% das instâncias: Servidor compartilhado (credenciais padrão)
- 10% das instâncias: Servidores dedicados (credenciais personalizadas)

## Migração de Instâncias Existentes

Se você já possui instâncias no banco de dados:

1. **Manter credenciais existentes**: Não faça nada, continuarão funcionando
2. **Migrar para credenciais padrão**:
   - Atualize a instância com `serverUrl` e `apiKey` vazios
   - Configure as credenciais padrão no `.env`

## Suporte

Para mais informações sobre o Evolution API, consulte:
- [Documentação Evolution API](https://doc.evolution-api.com/)
- [GitHub Evolution API](https://github.com/EvolutionAPI/evolution-api)
