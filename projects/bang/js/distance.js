// Bang! The Bullet — Distance & Range
(function(exports) {
'use strict';

const D = window.BangData;

const DistanceMixin = {
  apply(engine) {
    Object.assign(engine, DistanceMixin.methods);
  },

  methods: {
    calcDistance(fromIdx, toIdx) {
      if (fromIdx === toIdx) return 0;
      const alive = this.getAlivePlayers();
      const fromPos = alive.indexOf(fromIdx);
      const toPos = alive.indexOf(toIdx);
      if (fromPos < 0 || toPos < 0) return Infinity;
      const n = alive.length;
      const clockwise = (toPos - fromPos + n) % n;
      const counter = (fromPos - toPos + n) % n;
      let dist = Math.min(clockwise, counter);

      const isBelleTurn = this.state.currentTurn === fromIdx &&
        this.getEffectiveCharacter(fromIdx).effect === 'nullify_equipment';

      // Target's distance modifiers (Mustang, Hideout, Paul Regret)
      if (!isBelleTurn) {
        if (this.hasInPlay(toIdx, 'Mustang')) dist++;
        if (this.hasInPlay(toIdx, 'Hideout')) dist++;
      }
      if (this.getEffectiveCharacter(toIdx).effect === 'builtin_mustang') dist++;

      // Source's distance modifiers (Scope, Binocular, Rose Doolan)
      if (this.hasInPlay(fromIdx, 'Scope')) dist--;
      if (this.hasInPlay(fromIdx, 'Binocular')) dist--;
      if (this.getEffectiveCharacter(fromIdx).effect === 'builtin_scope') dist--;

      return Math.max(dist, 1);
    },

    getWeaponRange(playerIdx) {
      const p = this.state.players[playerIdx];
      const weapon = p.inPlay.find(c => D.isWeapon(c));
      return weapon ? D.getWeaponRange(weapon) : 1;
    },

    isInRange(fromIdx, toIdx) {
      return this.calcDistance(fromIdx, toIdx) <= this.getWeaponRange(fromIdx);
    },

    getValidTargets(pi, cardName) {
      const alive = this.getAlivePlayers().filter(i => i !== pi);
      switch (cardName) {
        case 'BANG!':
        case 'Missed!': // Calamity Janet
        case 'Punch':
          return alive.filter(i => this.isInRange(pi, i));
        case 'Panic!':
          return alive.filter(i => this.calcDistance(pi, i) <= 1 &&
            (this.state.players[i].hand.length > 0 || this.state.players[i].inPlay.length > 0));
        case 'Cat Balou':
        case 'Rag Time':
          return alive.filter(i =>
            this.state.players[i].hand.length > 0 || this.state.players[i].inPlay.length > 0);
        case 'Duel':
        case 'Springfield':
          return alive;
        case 'Jail':
          return alive.filter(i => this.state.players[i].role !== 'sheriff');
        case 'Tequila':
          return this.getAlivePlayers(); // Can target self
        default:
          return alive;
      }
    },
  },
};

exports.BangDistanceMixin = DistanceMixin;
})(window);
