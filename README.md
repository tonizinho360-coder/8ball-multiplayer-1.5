# 8 Ball Tournament — servidor multiplayer

## O que esta etapa entrega
- Criação real de salas de torneio com código de 6 caracteres.
- Entrada de jogadores em aparelhos diferentes pelo código.
- Lista de participantes sincronizada em tempo real.
- Botão de iniciar liberado apenas para o criador quando todas as vagas estiverem preenchidas.
- Formatos de 2, 4, 8 e 16 participantes.

## Como executar para testar
1. Instale Node.js 18 ou superior.
2. Extraia esta pasta.
3. No terminal, dentro da pasta, execute `npm install`.
4. Execute `npm start`.
5. Abra `http://localhost:3000` no navegador.

Para testar entre aparelhos, publique esta pasta em um serviço que aceite aplicações Node.js e abra o endereço HTTPS publicado nos dois aparelhos. O HTML já usa o Socket.IO servido pelo próprio Node.js.

## Importante
Esta entrega implementa o lobby e a sincronização da sala/chaveamento inicial. A partida de sinuca em si ainda não está sincronizada entre jogadores: física, tacadas, turnos, placar e resultado online exigem uma próxima etapa de multiplayer de gameplay. As salas ficam em memória e são encerradas se o servidor reiniciar. Não há Pix, dinheiro real ou premiação financeira implementados.
