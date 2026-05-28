import { closestMidiForNote, clampMidiToRange, midiToNote, noteNameFromMidi } from './notes'
import type { AmbientRole, Chord, GestureFeatures, MelodyEvent, RhythmValue, StylePreset } from './types'

type Random = () => number
type AmbientIntent = 'none' | 'swipe' | 'circle'

const rhythmSeconds: Record<RhythmValue, number> = {
  '8n': 0.5,
  '4n': 1,
  '2n': 2,
  '1n': 4,
}

const weightedPick = <T,>(items: Array<[T, number]>, random: Random): T => {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0)
  let cursor = random() * total
  for (const [item, weight] of items) {
    cursor -= weight
    if (cursor <= 0) return item
  }
  return items[items.length - 1][0]
}

export function secondsForRhythm(duration: RhythmValue, tempo: number) {
  return rhythmSeconds[duration] * (60 / tempo)
}

export class MelodyEngine {
  private preset: StylePreset
  private random: Random
  private chordIndex = 0
  private lastMidi = 60
  private motif: number[] = []
  private phraseStep = 0
  private arpStepsLeft = 0

  constructor(preset: StylePreset, random: Random = Math.random) {
    this.preset = preset
    this.random = random
  }

  setPreset(preset: StylePreset) {
    this.preset = preset
    this.chordIndex = 0
    this.lastMidi = preset.id === 'mysterious' ? 57 : 60
    this.motif = []
    this.phraseStep = 0
    this.arpStepsLeft = 0
  }

  next(gesture: GestureFeatures, intent: AmbientIntent = 'none'): MelodyEvent {
    const chord = this.preset.chords[this.chordIndex]
    const role = this.roleFor(gesture, intent)
    const duration = this.rhythmFor(gesture, role)
    const velocity = this.velocityFor(gesture, role)
    const texture = Math.min(1, 0.08 + gesture.size * 0.7 + gesture.speed * 0.36 + gesture.sharpness * 0.22)
    const wide = gesture.handCount > 1 || gesture.size > 0.5

    if (intent === 'circle') {
      this.arpStepsLeft = 8
      this.motif = this.createArp(chord, gesture)
    }

    if (role === 'rest') {
      this.advance(role)
      return {
        duration,
        velocity: 0,
        articulation: 'legato',
        chord,
        motif: this.motif.map((note) => midiToNote(note)),
        role,
        texture,
        wide,
      }
    }

    const midi = this.midiFor(role, chord, gesture)
    const harmony = this.harmonyFor(midi, chord, wide)
    this.lastMidi = midi
    this.advance(role)

    return {
      note: midiToNote(midi),
      midi,
      duration,
      velocity,
      articulation: role === 'bell' ? 'staccato' : role === 'pad' || role === 'chord' ? 'legato' : gesture.articulation,
      chord,
      motif: this.motif.map((note) => midiToNote(note)),
      harmony,
      role,
      texture,
      wide,
    }
  }

  private roleFor(gesture: GestureFeatures, intent: AmbientIntent): AmbientRole {
    if (intent === 'circle' || this.arpStepsLeft > 0) return 'arp'
    if (intent === 'swipe' || gesture.sharpness > 0.5 || gesture.speed > 0.58) return 'bell'
    if (gesture.handCount < 1 || (gesture.speed < 0.1 && gesture.sharpness < 0.22)) return 'pad'
    if (gesture.handCount > 1 && gesture.size > 0.34 && this.random() > 0.18) return 'chord'
    if (this.random() < this.restChance(gesture)) return 'rest'
    return gesture.speed < 0.18 ? 'pad' : 'melody'
  }

  private restChance(gesture: GestureFeatures) {
    const density = Math.min(0.62, gesture.speed * 0.56 + gesture.sharpness * 0.28 + gesture.handCount * 0.04)
    return Math.max(0.2, 0.58 - density)
  }

  private rhythmFor(gesture: GestureFeatures, role: AmbientRole): RhythmValue {
    if (role === 'pad' || role === 'chord') return gesture.speed < 0.12 ? '1n' : '2n'
    if (role === 'arp') return gesture.speed > 0.34 ? '4n' : '2n'
    if (role === 'bell') return '4n'
    if (gesture.speed < 0.18) return '2n'
    if (gesture.speed > 0.48) return '4n'
    return weightedPick(
      this.preset.rhythmBias.map((duration, index) => [duration, index === 0 ? 2 : 1]),
      this.random,
    )
  }

  private velocityFor(gesture: GestureFeatures, role: AmbientRole) {
    const base = role === 'pad' ? 0.2 : role === 'chord' ? 0.27 : role === 'bell' ? 0.34 : 0.28
    return Math.min(0.95, base + gesture.size * 0.42 + gesture.speed * 0.22 + gesture.sharpness * 0.24)
  }

  private midiFor(role: AmbientRole, chord: Chord, gesture: GestureFeatures) {
    const rangeMin = 40 + Math.round(gesture.height * 30)
    const rangeMax = rangeMin + (role === 'bell' ? 31 : role === 'arp' ? 25 : 20)

    if (role === 'arp' && this.motif.length) {
      const arpMidi = this.motif[this.phraseStep % this.motif.length]
      return this.snapToAllowedPool(clampMidiToRange(arpMidi, rangeMin, rangeMax), chord)
    }

    if (role === 'pad' || role === 'chord') {
      const padLift = Math.round(gesture.size * 8) + (gesture.direction === 'up' ? 5 : gesture.direction === 'down' ? -5 : 0)
      return this.snapToAllowedPool(closestMidiForNote(chord.notes[0], rangeMin + 7 + padLift), chord)
    }

    const pool = [
      ...chord.notes.map((note) => [note, 6] as [string, number]),
      ...this.preset.scale.map((note) => [note, role === 'bell' ? 3 : 2] as [string, number]),
    ]
    const targetNote = weightedPick(pool, this.random)
    const target = closestMidiForNote(targetNote, this.lastMidi)
    const drift = gesture.direction === 'up' ? 7 : gesture.direction === 'down' ? -7 : Math.round((gesture.horizontal - 0.5) * 8)
    const speedLeap = Math.round(gesture.speed * (role === 'bell' ? 12 : 7))
    const step = role === 'bell' ? Math.round(gesture.height * 14) + drift + speedLeap : drift + Math.round(speedLeap / 2)

    return this.snapToAllowedPool(clampMidiToRange(Math.round((target + this.lastMidi) / 2) + step, rangeMin, rangeMax), chord)
  }

  private createArp(chord: Chord, gesture: GestureFeatures) {
    const base = 42 + Math.round(gesture.height * 26)
    const notes = chord.notes.flatMap((note, index) => [
      closestMidiForNote(note, base + index * 4),
      closestMidiForNote(note, base + 14 + index * 3 + Math.round(gesture.speed * 5)),
    ])
    return notes
      .map((note) => this.snapToAllowedPool(note, chord))
      .sort((a, b) => (gesture.direction === 'down' ? b - a : a - b))
      .slice(0, 8)
  }

  private harmonyFor(midi: number, chord: Chord, wide: boolean) {
    const intervals = wide ? [-19, -12, -5, 7, 12] : [-7]
    return intervals.map((interval) => midiToNote(this.snapToAllowedPool(midi + interval, chord)))
  }

  private snapToAllowedPool(midi: number, chord: Chord) {
    const allowedNames = new Set([...chord.notes, ...this.preset.scale])
    const candidates = Array.from({ length: 25 }, (_, index) => midi - 12 + index)
      .filter((candidate) => allowedNames.has(noteNameFromMidi(candidate)))
      .sort((a, b) => Math.abs(a - midi) - Math.abs(b - midi))

    return candidates[0] ?? midi
  }

  private advance(role: AmbientRole) {
    this.phraseStep += 1
    if (role === 'arp') this.arpStepsLeft = Math.max(0, this.arpStepsLeft - 1)
    if (this.phraseStep % 4 === 0) {
      this.chordIndex = (this.chordIndex + 1) % this.preset.chords.length
    }
  }
}
