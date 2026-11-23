// Play test part 2b: the warrior avatar walking the map, ported from HappyTool/GUI/StageViewerForm.PlayActions.cs
// (ActRunner, StartAct, RunAct, AdvanceAct, NextAct, ActSpeedRate, TurnToward, StartAvatarPlay, AvatarInput,
// AvatarAfterMove, RespawnAvatar), StageViewerForm.Play.cs AvatarStep and StageViewerForm.PlayAvatar.cs DrawAvatar /
// DrawAvatarMesh. The avatar itself comes from formats/avatar.js. The stage's character light isn't read, so the
// figure is shaded the way the desktop shades it without one.

import { PLAY, resolveContacts } from './stage-play.js';
import { poseSkeleton, skinPositions, mul4, transformPoint, transformVector } from '../formats/skin.js';

const AVATAR_FPS = 60;
const isAttack = (s) => s.startsWith('attack') || s === 'blow_attack';
const isGuarding = (s) => s.startsWith('guard') && s !== 'guard_off';

/** ActRunner: the state the warrior's action script is in. */
export const newAct = () => ({
  state: '', cmds: [], pc: 0, clip: null, fromClip: null, frame: 0, fromFrame: 0, blend: 1, blendFrames: 0, pendingLerp: 0,
  done: false, hitting: false, queued: false, comboAt: -1, speedRate: 1, loops: false,
});

const lastFrame = (a, clip) => {
  const d = clip != null ? a.clips.get(clip) : null;
  return d ? Math.max(0, d.frameCount - 1) : 0;
};

/** StartAct: run a state's commands from the top, cross-fading from the clip that was playing. */
export function startAct(a, r, state) {
  const cmds = a?.script.get(state);
  if (!cmds) return false;
  r.fromClip = r.clip;
  r.fromFrame = r.frame;
  r.state = state;
  r.cmds = cmds;
  r.pc = 0;
  r.done = r.hitting = r.queued = r.loops = false;
  r.comboAt = -1;
  r.speedRate = 1;
  r.pendingLerp = 0;
  runAct(a, r);
  return true;
}

/** RunAct: carry on through the commands until one waits for a frame. */
function runAct(a, r) {
  while (r.pc < r.cmds.length) {
    const c = r.cmds[r.pc];
    switch (c.kind) {
      case 'LerpFrame': r.pendingLerp = c.value; break;
      case 'Anm':
        if (r.clip != null && r.clip !== c.anim) (r.fromClip = r.clip), (r.fromFrame = r.frame);
        r.clip = a.clips.has(c.anim ?? '') ? c.anim : r.clip;
        r.frame = c.value;
        r.blendFrames = r.pendingLerp;
        r.blend = r.pendingLerp > 0 && r.fromClip != null ? 0 : 1;
        r.pendingLerp = 0;
        break;
      case 'Frame':
        if (r.frame < c.value) return;
        break;
      case 'FrameEnd':
        if (r.frame < lastFrame(a, r.clip)) return;
        r.done = true;
        break;
      case 'Hit': r.hitting = true; break;
      case 'HitEnd': r.hitting = false; break;
      case 'AttackWait': r.comboAt = c.value; break;
      case 'TempSpeed': r.speedRate = c.value > 0 ? c.value : 1; break;
    }
    r.pc++;
  }
  if (!r.done) r.loops = true;
}

/** AdvanceAct: move the clip on by dt (the game's 60 frames a second, times the state's speed). */
export function advanceAct(a, r, dt) {
  const frames = dt * AVATAR_FPS * r.speedRate, last = lastFrame(a, r.clip);
  r.frame += frames;
  if (r.frame > last) r.frame = r.loops && last > 0 ? r.frame % last : last;
  if (r.fromClip != null) r.fromFrame = Math.min(r.fromFrame + frames, lastFrame(a, r.fromClip));
  if (r.blend < 1) r.blend = r.blendFrames > 0 ? Math.min(1, r.blend + frames / r.blendFrames) : 1;
  runAct(a, r);
}

/** NextAct: the state the input asks for, or null to stay. */
export function nextAct(a, r, moving, attack, blow, guard) {
  const s = r.state, attacking = isAttack(s), guarding = isGuarding(s), idle = moving ? 'run_begin' : 'stand';
  switch (s) {
    case 'fall': case 'falldie': case 'infinite_fall': return null; // landing and dying are decided by the movement step
    case 'land': case 'falldamage': return r.done ? idle : null;
    case 'guard_off': return r.done ? idle : null;
  }
  if (attacking) {
    if (attack && s.startsWith('attack')) r.queued = true;
    const tail = s.slice(6);
    if (r.queued && r.comboAt >= 0 && r.frame >= r.comboAt && /^\s*[+-]?\d+\s*$/.test(tail) && a.script.has('attack' + (parseInt(tail, 10) + 1)))
      return 'attack' + (parseInt(tail, 10) + 1);
    return r.done ? idle : null;
  }
  if (guard) {
    if (!guarding) return 'guard_on';
    if (s === 'guard_on') return r.done ? (moving ? 'guard_walk_begin' : 'guard') : null;
    if (moving) return s === 'guard_walk_begin' || s === 'guard_walk' ? (r.done ? 'guard_walk' : null) : 'guard_walk_begin';
    return s === 'guard' ? (r.done ? 'guard' : null) : 'guard';
  }
  if (guarding) return 'guard_off';
  if (attack) return 'attack1';
  if (blow) return 'blow_attack';
  if (moving) return s === 'run_begin' || s === 'run' ? null : 'run_begin';
  return s === 'stand' ? null : 'stand';
}

/** ActSpeedRate: how fast the warrior may move in a state, as a share of its run. */
export function actSpeedRate(a, r) {
  const s = r.state ?? '';
  if (s === 'land' || s === 'falldamage' || s === 'falldie' || s === 'infinite_fall') return 0;
  if (isAttack(s)) return a.attackSpeedRate;
  if (isGuarding(s)) return a.guardSpeedRate;
  return 1;
}

/** TurnToward: an angle turned toward another by at most degPerSec for dt. */
export function turnToward(facing, want, degPerSec, dt) {
  let d = want - facing;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const max = ((degPerSec * Math.PI) / 180) * dt;
  return facing + Math.max(-max, Math.min(max, d));
}

/** StartAvatarPlay: the warrior standing, at full HP; the key that started play doesn't swing. */
export function startAvatar(a, p) {
  p.act = newAct();
  p.hits = 0;
  p.attackHeld = p.blowHeld = true;
  startAct(a, p.act, 'stand');
  p.act.blend = 1;
  p.act.fromClip = null;
  p.hp = a.hpMax;
  p.fallTop = p.pos[1];
}

// AvatarInput: the next state from the keys, then the clip moved on. Returns { rate, turn }.
function avatarInput(a, p, dt, move, attack, blow, guard) {
  const r = p.act, attackEdge = attack && !p.attackHeld, blowEdge = blow && !p.blowHeld;
  p.attackHeld = attack;
  p.blowHeld = blow;
  const wasHitting = r.hitting;
  const next = nextAct(a, r, move[0] * move[0] + move[1] * move[1] > 0.01, attackEdge, blowEdge, guard);
  if (next != null) startAct(a, r, next);
  advanceAct(a, r, dt);
  if (r.hitting && !wasHitting) p.hits++;
  const rate = actSpeedRate(a, r);
  // Guarding keeps the shield toward where it faced; everything else turns toward the stick.
  return { rate, turn: !isGuarding(r.state) && rate > 0 };
}

function respawn(a, p, why) {
  p.pos = p.spawn.slice();
  p.vel = [0, 0, 0];
  p.fallTop = p.pos[1];
  p.hp = Math.max(1, (a.hpMax * a.respawnHpPer) / 100);
  startAct(a, p.act, 'stand');
  return why + ' — back where play started (HP ' + p.hp.toFixed(0) + ')';
}

// AvatarAfterMove: falls, landings, fall damage and falling out of the map. Returns a message for the HUD, or null.
function afterMove(w, a, p, wasGround) {
  const r = p.act;
  let say = null;
  if (!p.ground) {
    p.fallTop = Math.max(p.fallTop, p.pos[1]);
    if (r.state !== 'fall' && r.state !== 'infinite_fall' && p.fallTop - p.pos[1] > a.fallDistance) startAct(a, r, 'fall');
  } else {
    const drop = p.fallTop - p.pos[1];
    if (!wasGround && r.state === 'fall') {
      if (drop >= a.fallDamageDistanceMax) p.hp = 0;
      else if (drop >= a.fallDamageDistance) {
        const t = (drop - a.fallDamageDistance) / Math.max(1, a.fallDamageDistanceMax - a.fallDamageDistance);
        const dmg = a.fallDamageHp + (a.fallDamageHpMax - a.fallDamageHp) * t;
        p.hp = Math.max(0, p.hp - dmg);
        say = `Fell ${(drop / 100).toFixed(1)} m — ${dmg.toFixed(0)} damage`;
      }
      startAct(a, r, p.hp <= 0 ? 'falldie' : drop >= a.fallDamageDistance ? 'falldamage' : 'land');
    }
    p.fallTop = p.pos[1];
  }
  const dieY = w.minY > a.fallDieY ? a.fallDieY : w.minY - 3000;
  if (p.pos[1] < dieY && r.state !== 'infinite_fall') startAct(a, r, 'infinite_fall');
  if ((r.state === 'falldie' || r.state === 'infinite_fall') && r.done)
    say = respawn(a, p, r.state === 'infinite_fall' ? 'Fell out of the map' : 'Down from the fall');
  return say;
}

/**
 * AvatarStep: the warrior's step. Its state from the input, the game's speed and turn rates, no jump (the game has
 * none), then falls, landings and fall damage. move = (right, forward) relative to the view's forward f (yaw is the
 * fallback when looking straight down). Returns a message for the HUD, or null.
 */
export function avatarStep(w, a, p, dt, move, attack, blow, guard, f, yaw) {
  let fx = f[0], fz = f[2];
  const fl = Math.hypot(fx, fz);
  if (fl > 1e-3) (fx /= fl), (fz /= fl);
  else (fx = Math.sin(yaw)), (fz = -Math.cos(yaw));
  const rx = -fz, rz = fx; // cross(forward, up)
  const wx = fx * move[1] + rx * move[0], wz = fz * move[1] + rz * move[0];
  const { rate, turn } = avatarInput(a, p, dt, move, attack, blow, guard);
  const speed = a.moveSpeed * rate, k = Math.min(1, (p.ground ? 14 : 3) * dt), v = p.vel;
  v[0] += (wx * speed - v[0]) * k;
  v[2] += (wz * speed - v[2]) * k;
  if (turn && wx * wx + wz * wz > 1e-4)
    p.facing = turnToward(p.facing, Math.atan2(wx, wz), isAttack(p.act.state) ? a.attackTurnSpeed : a.turnSpeed, dt);
  v[1] = Math.max(v[1] - PLAY.gravity * dt, -5000);
  const wasGround = p.ground;
  p.ground = false;
  const dx = v[0] * dt, dy = v[1] * dt, dz = v[2] * dt;
  const steps = Math.max(1, Math.min(12, Math.ceil(Math.hypot(dx, dy, dz) / (PLAY.radius * 0.5))));
  for (let s = 0; s < steps; s++) {
    p.pos[0] += dx / steps;
    p.pos[1] += dy / steps;
    p.pos[2] += dz / steps;
    resolveContacts(w, p);
  }
  if (!p.ground && wasGround && v[1] <= 0) {
    const from = [p.pos[0], p.pos[1] + PLAY.step, p.pos[2]];
    const h = w.raycast(from, [0, -1, 0], PLAY.step * 2 + 5);
    if (h && w.n[h.tri * 3 + 1] >= PLAY.walkable) {
      p.pos[1] = from[1] - h.t;
      p.ground = true;
      p.groundTri = h.tri;
      v[1] = 0;
    }
  }
  p.air = p.ground ? 0 : p.air + dt;
  return afterMove(w, a, p, wasGround);
}

/** The HUD's avatar part (PlayHudText): HP and the action state. */
export const avatarHud = (a, p) =>
  p.act?.state ? `   ·   HP ${p.hp.toFixed(0)}/${a.hpMax.toFixed(0)}   ·   ${p.act.state}${p.act.hitting ? ' (hit)' : ''}` : '';

const AVATAR_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUv;
layout(location=2) in float aShade;
uniform mat4 uViewProj;
uniform vec3 uAt;
uniform float uFacing;
out vec2 vUv;
out float vShade;
void main() {
  float c = cos(uFacing), s = sin(uFacing);
  vec3 p = vec3(c * aPos.x + s * aPos.z, aPos.y, -s * aPos.x + c * aPos.z);
  vUv = aUv;
  vShade = aShade;
  gl_Position = uViewProj * vec4(uAt + p, 1.0);
}`;
const AVATAR_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
in float vShade;
uniform sampler2D uTex;
uniform bool uTextured;
out vec4 outColor;
void main() {
  vec4 t = uTextured ? texture(uTex, vUv) : vec4(1.0);
  if (t.a <= 0.4) discard;
  outColor = vec4(t.rgb * vShade, 1.0);
}`;

const LIGHT = (() => {
  const l = Math.hypot(0.4, 1, 0.6);
  return [0.4 / l, 1 / l, 0.6 / l];
})();
// FigureShade without the stage's character light.
const shade = (x, y, z) => 0.55 + 0.45 * Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]);

/** The avatar's drawer: draw(vp, player, avatar) draws the posed warrior where the player is. */
export function avatarDrawer(gl) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, AVATAR_VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, AVATAR_FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const U = Object.fromEntries(['uViewProj', 'uAt', 'uFacing', 'uTex', 'uTextured'].map((n) => [n, gl.getUniformLocation(prog, n)]));
  const vao = gl.createVertexArray(), buf = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  const textures = new WeakMap();
  const textureOf = (img) => {
    if (!img) return null;
    let t = textures.get(img);
    if (!t) {
      t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength));
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.bindTexture(gl.TEXTURE_2D, null);
      textures.set(img, t);
    }
    return t;
  };
  let data = new Float32Array(0);
  return {
    draw(vp, p, a) {
      const r = p.act;
      const pose = poseSkeleton(a.rig, a.clips.get(r.clip) ?? null, r.frame, a.clips.get(r.fromClip) ?? null, r.fromFrame, r.blend);
      const body = skinPositions(a.rig, pose);
      const meshes = [{ mesh: a.rig.mesh, texture: a.bodyTexture, P: body.positions, N: body.normals }];
      for (const part of a.parts) {
        if (part.bone < 0 || part.bone >= pose.length) continue;
        const m = mul4(pose[part.bone], part.unturn), src = part.mesh.positions, sn = part.mesh.normals;
        const vc = Math.floor(src.length / 3), P = new Float32Array(vc * 3), hasN = sn && sn.length >= vc * 3, N = hasN ? new Float32Array(vc * 3) : null;
        for (let i = 0; i < vc; i++) {
          const q = transformPoint(m, src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
          (P[i * 3] = q[0]), (P[i * 3 + 1] = q[1]), (P[i * 3 + 2] = q[2]);
          if (!hasN) continue;
          const n = transformVector(m, sn[i * 3], sn[i * 3 + 1], sn[i * 3 + 2]), l = Math.hypot(n[0], n[1], n[2]) || 1;
          (N[i * 3] = n[0] / l), (N[i * 3 + 1] = n[1] / l), (N[i * 3 + 2] = n[2] / l);
        }
        meshes.push({ mesh: part.mesh, texture: part.texture, P, N });
      }
      let need = 0;
      for (const d of meshes) need += Math.floor(d.mesh.indices.length / 3) * 18;
      if (data.length < need) data = new Float32Array(need);
      let o = 0;
      const runs = [];
      // DrawAvatarMesh: skip triangles out of range or with no area; smooth shade with normals, flat without.
      for (const d of meshes) {
        const { P, N } = d, idx = d.mesh.indices, T = d.mesh.uvs, vc = Math.floor(P.length / 3);
        const uv = T && T.length >= vc * 2, first = o / 6;
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
          if (i0 >= vc || i1 >= vc || i2 >= vc) continue;
          const ax = P[i1 * 3] - P[i0 * 3], ay = P[i1 * 3 + 1] - P[i0 * 3 + 1], az = P[i1 * 3 + 2] - P[i0 * 3 + 2];
          const bx = P[i2 * 3] - P[i0 * 3], by = P[i2 * 3 + 1] - P[i0 * 3 + 1], bz = P[i2 * 3 + 2] - P[i0 * 3 + 2];
          let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
          const l2 = nx * nx + ny * ny + nz * nz;
          if (l2 < 1e-12) continue;
          const l = Math.sqrt(l2);
          (nx /= l), (ny /= l), (nz /= l);
          const flat = shade(nx, ny, nz);
          for (const i of [i0, i1, i2]) {
            data[o++] = P[i * 3];
            data[o++] = P[i * 3 + 1];
            data[o++] = P[i * 3 + 2];
            data[o++] = uv ? T[i * 2] : 0;
            data[o++] = uv ? T[i * 2 + 1] : 0;
            data[o++] = N ? shade(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) : flat;
          }
        }
        if (o / 6 > first) runs.push({ first, count: o / 6 - first, tex: textureOf(d.texture) });
      }
      gl.useProgram(prog);
      gl.uniformMatrix4fv(U.uViewProj, false, vp);
      gl.uniform3fv(U.uAt, p.pos);
      gl.uniform1f(U.uFacing, p.facing);
      gl.uniform1i(U.uTex, 0);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, o), gl.DYNAMIC_DRAW);
      gl.activeTexture(gl.TEXTURE0);
      for (const run of runs) {
        gl.bindTexture(gl.TEXTURE_2D, run.tex);
        gl.uniform1i(U.uTextured, run.tex ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, run.first, run.count);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindVertexArray(null);
    },
  };
}
