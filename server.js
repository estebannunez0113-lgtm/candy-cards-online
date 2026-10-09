
function endRoom(room, winnerId = null, reason = null) {
    if (!room || !rooms.has(room.code)) return;

    const winner = winnerId
        ? room.players.find(p => p.id === winnerId)
        : null;

    for (const player of room.players) {
        const isWinner = Boolean(
            winner && player.id === winnerId
        );

        let winnerForPlayer = winner
            ? winner.data.username
            : null;

        // If both players use the same username,
        // make sure the loser does not receive a win.
        if (
            winner &&
            !isWinner &&
            winnerForPlayer === player.data.username
        ) {
            winnerForPlayer += ' (opponent won)';
        }

        send(player.ws, {
            type: 'battle_result',
            winner: winnerForPlayer
        });

        if (reason && player.id !== winnerId) {
            send(player.ws, {
                type: 'opponent_left',
                message: reason
            });
        }

        players.delete(player.ws);
    }

    rooms.delete(room.code);
    console.log(`Room ${room.code} closed.`);
}
