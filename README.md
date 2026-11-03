# Jarvis

Assistente de voz estilo Tony Stark em uma página: orbe animado, escuta e fala pelo navegador, e o cérebro é o `claude` da sua assinatura com acesso só ao ClickUp (a agenda são as datas de entrega das tarefas).

## Como usar

```
npm i
npm run dev
```

Abra http://127.0.0.1:5173 no **Chrome**, clique no orbe (ou segure Espaço) e fale — ou digite a pergunta na caixa abaixo do orbe e dê Enter. A resposta é falada e o texto aparece embaixo.

**Instalar como app:** no Chrome, clique no ícone de instalar na barra de endereço (ou menu ⋮ → Instalar Jarvis). O servidor (`npm run dev`) precisa estar rodando.

- **Pré-requisito:** o CLI `claude` logado e com o MCP do ClickUp conectado.
- **Música:** ponha o seu arquivo em `public/back-in-black.mp3` (fica fora do git, direito autoral). Sem o arquivo, o Jarvis só não toca nada.
- **Microfone:** permita quando o Chrome pedir.
- O Chrome pode exigir um clique na primeira vez para liberar o som (política de autoplay); o primeiro clique ou tecla na página já basta.
- O servidor fica preso em 127.0.0.1 porque `/api/chat` executa o `claude` — não exponha na rede.
