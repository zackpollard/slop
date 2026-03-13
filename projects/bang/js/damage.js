// Bang! The Bullet — Damage, Elimination & Win Conditions
(function(exports) {
'use strict';

const DamageMixin = {
  apply(engine) {
    Object.assign(engine, DamageMixin.methods);
  },

  methods: {
    applyDamage(playerIdx, amount, sourceIdx) {
      const player = this.state.players[playerIdx];
      const eff = this.getEffectiveCharacter(playerIdx);

      for (let i = 0; i < amount; i++) {
        if (player.eliminated) break;
        player.hp--;

        // Bart Cassidy: draw a card per HP lost
        if (eff.effect === 'on_damage_draw') {
          const drawn = this.drawFromDeck(1);
          player.hand.push(...drawn);
          if (drawn.length > 0) this.addLog(player.name + ' draws a card (Bart Cassidy).');
        }

        // El Gringo: draw from attacker's hand
        if (eff.effect === 'on_damage_steal' && sourceIdx >= 0) {
          const src = this.state.players[sourceIdx];
          if (src && src.hand.length > 0) {
            const ri = Math.floor(Math.random() * src.hand.length);
            player.hand.push(src.hand.splice(ri, 1)[0]);
            this.addLog(player.name + ' steals a card from ' + src.name + ' (El Gringo).');
          }
        }

        if (player.hp <= 0) {
          // Check beer save
          if (this.getAliveCount() > 2 && player.hand.some(c => c.name === 'Beer')) {
            this.state.pending = {
              type: 'beer_save',
              playerIdx,
              killerIdx: sourceIdx >= 0 ? sourceIdx : -1,
            };
            return;
          }
          this.eliminatePlayer(playerIdx, sourceIdx >= 0 ? sourceIdx : -1);
          return;
        }
      }
    },

    eliminatePlayer(playerIdx, killerIdx) {
      const player = this.state.players[playerIdx];
      player.eliminated = true;
      player.hp = 0;
      this.addLog(player.name + ' (' + player.role + ') has been eliminated!');

      // Vulture Sam gets all cards
      const vultureIdx = this.getAlivePlayers().find(i =>
        this.getEffectiveCharacter(i).effect === 'vulture'
      );

      if (vultureIdx !== undefined) {
        const vs = this.state.players[vultureIdx];
        vs.hand.push(...player.hand, ...player.inPlay);
        this.addLog(vs.name + ' takes all cards from ' + player.name + ' (Vulture Sam).');
      } else {
        this.state.discard.push(...player.hand, ...player.inPlay);
      }
      player.hand = [];
      player.inPlay = [];

      // Greg Digger heals 2
      for (const i of this.getAlivePlayers()) {
        if (this.getEffectiveCharacter(i).effect === 'heal_on_eliminate') {
          const gd = this.state.players[i];
          const heal = Math.min(2, gd.maxHp - gd.hp);
          if (heal > 0) {
            gd.hp += heal;
            this.addLog(gd.name + ' heals ' + heal + ' HP (Greg Digger).');
          }
        }
        if (this.getEffectiveCharacter(i).effect === 'draw_on_eliminate') {
          const hh = this.state.players[i];
          hh.hand.push(...this.drawFromDeck(2));
          this.addLog(hh.name + ' draws 2 cards (Herb Hunter).');
        }
      }

      // Rewards/penalties
      if (player.role === 'outlaw' && killerIdx >= 0) {
        const killer = this.state.players[killerIdx];
        if (!killer.eliminated) {
          killer.hand.push(...this.drawFromDeck(3));
          this.addLog(killer.name + ' draws 3 cards for killing an Outlaw!');
        }
      }
      if (player.role === 'deputy' && killerIdx >= 0 && this.state.players[killerIdx].role === 'sheriff') {
        const sheriff = this.state.players[killerIdx];
        this.addLog('The Sheriff killed a Deputy! ' + sheriff.name + ' discards all cards!');
        this.state.discard.push(...sheriff.hand, ...sheriff.inPlay);
        sheriff.hand = [];
        sheriff.inPlay = [];
      }

      this.checkWinCondition();
    },

    checkWinCondition() {
      const alive = this.getAlivePlayers();
      const aliveRoles = alive.map(i => this.state.players[i].role);

      const sheriffAlive = aliveRoles.includes('sheriff');
      if (!sheriffAlive) {
        if (aliveRoles.every(r => r === 'renegade')) {
          this.state.winner = { team: 'renegade', desc: 'Renegade wins!' };
        } else {
          this.state.winner = { team: 'outlaw', desc: 'Outlaws win!' };
        }
        this.state.phase = 'gameOver';
        this.addLog(this.state.winner.desc);
        return;
      }

      const threatsAlive = aliveRoles.some(r => r === 'outlaw' || r === 'renegade');
      if (!threatsAlive) {
        this.state.winner = { team: 'sheriff', desc: 'Sheriff and Deputies win!' };
        this.state.phase = 'gameOver';
        this.addLog(this.state.winner.desc);
        return;
      }
    },
  },
};

exports.BangDamageMixin = DamageMixin;
})(window);
