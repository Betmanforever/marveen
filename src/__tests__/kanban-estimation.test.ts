import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, moveKanbanCard, updateKanbanCard, getKanbanCard,
  kanbanActualHours, estimationAccuracy, kanbanTimingForTransition,
} from '../db.js'

// Estimate-vs-actual work-time tracking (kanban #87a97029). Actual hours come
// from work_started_at (first in_progress) -> work_completed_at (done); the
// accuracy target is the 0.9-1.1 band (90% goal).

describe('estimationAccuracy', () => {
  it('hits inside the 0.9-1.1 band, misses outside', () => {
    expect(estimationAccuracy(10, 10).hit).toBe(true)
    expect(estimationAccuracy(10, 9).hit).toBe(true)   // ratio 0.9
    expect(estimationAccuracy(10, 11).hit).toBe(true)  // ratio 1.1
    expect(estimationAccuracy(10, 8).hit).toBe(false)  // under-estimate work? 0.8
    expect(estimationAccuracy(10, 13).hit).toBe(false) // 1.3
  })
  it('respects a custom band', () => {
    expect(estimationAccuracy(10, 12, 0.25).hit).toBe(true) // ratio 1.2, band 25%
  })
  it('returns nulls for missing/zero inputs', () => {
    expect(estimationAccuracy(null, 5)).toEqual({ ratio: null, hit: null })
    expect(estimationAccuracy(5, null)).toEqual({ ratio: null, hit: null })
    expect(estimationAccuracy(0, 5)).toEqual({ ratio: null, hit: null })
  })
})

describe('kanbanActualHours', () => {
  it('computes hours from the timing stamps', () => {
    expect(kanbanActualHours({ work_started_at: 1000, work_completed_at: 1000 + 3600 })).toBe(1)
    expect(kanbanActualHours({ work_started_at: 1000, work_completed_at: 1000 + 1800 })).toBe(0.5)
  })
  it('is null when not fully/validly tracked', () => {
    expect(kanbanActualHours({ work_started_at: null, work_completed_at: 5 })).toBeNull()
    expect(kanbanActualHours({ work_started_at: 5, work_completed_at: null })).toBeNull()
    expect(kanbanActualHours({ work_started_at: 100, work_completed_at: 50 })).toBeNull()
  })
})

describe('kanbanTimingForTransition', () => {
  const base = { status: 'planned' as const, work_started_at: null, work_completed_at: null }
  it('stamps work_started_at on the first in_progress only', () => {
    expect(kanbanTimingForTransition(base, 'in_progress', 111)).toEqual({ work_started_at: 111 })
    // already started -> no change
    expect(kanbanTimingForTransition({ ...base, status: 'waiting', work_started_at: 50 }, 'in_progress', 111)).toEqual({})
  })
  it('stamps work_completed_at on done (and back-fills start on a direct planned->done)', () => {
    expect(kanbanTimingForTransition({ ...base, work_started_at: 50 }, 'done', 200)).toEqual({ work_completed_at: 200 })
    expect(kanbanTimingForTransition(base, 'done', 200)).toEqual({ work_started_at: 200, work_completed_at: 200 })
  })
})

describe('end-to-end timing via the real card lifecycle', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('captures work_started_at on in_progress and work_completed_at on done (move path)', () => {
    createKanbanCard({ id: 'C1', title: 'x', assignee: 'neo', estimated_hours: 2, estimated_by: 'neo' })
    let c = getKanbanCard('C1')!
    expect(c.estimated_hours).toBe(2)
    expect(c.work_started_at).toBeNull()

    moveKanbanCard('C1', 'in_progress', 0)
    c = getKanbanCard('C1')!
    expect(c.work_started_at).not.toBeNull()
    expect(c.work_completed_at).toBeNull()
    const started = c.work_started_at

    moveKanbanCard('C1', 'waiting', 0)      // waiting must NOT reset the start
    moveKanbanCard('C1', 'in_progress', 0)  // re-entering in_progress keeps the original start
    c = getKanbanCard('C1')!
    expect(c.work_started_at).toBe(started)

    moveKanbanCard('C1', 'done', 0)
    c = getKanbanCard('C1')!
    expect(c.work_completed_at).not.toBeNull()
    expect(kanbanActualHours(c)).not.toBeNull()
  })

  it('the update path also auto-captures timing on a status change', () => {
    createKanbanCard({ id: 'C2', title: 'y', assignee: 'neo' })
    updateKanbanCard('C2', { status: 'in_progress' })
    expect(getKanbanCard('C2')!.work_started_at).not.toBeNull()
  })
})
