import assert from 'node:assert/strict'
import { test } from 'vitest'

import { analyzeQuery } from '../src/retrieval/query-analysis.ts'

function facetsOf(query: string): string[] {
  return analyzeQuery(query).facets.map((facet) => facet.text)
}

test('aspects are multi-label and general stands alone', () => {
  assert.deepEqual(analyzeQuery('我现在使用什么模型？').aspects, ['current'])
  assert.deepEqual(analyzeQuery('我以前住在苏州，现在住在上海').aspects, ['current', 'history'])
  assert.deepEqual(analyzeQuery('我的模型变了吗？').aspects, ['change'])
  assert.deepEqual(analyzeQuery('昨天发生了什么？').aspects, ['event_time'])
  assert.deepEqual(analyzeQuery('我喜欢评弹').aspects, ['general'])
  assert.deepEqual(analyzeQuery('I used to live in Suzhou and now I live in Shanghai').aspects, [
    'current',
    'history',
  ])
})

test('facets split clauses and conjunctions without cutting words apart', () => {
  assert.deepEqual(facetsOf('我喜欢苹果和香蕉'), ['我喜欢苹果', '香蕉'])
  assert.deepEqual(facetsOf('我喜欢和平'), [])
  assert.deepEqual(facetsOf('上个月去了苏州，这个月去了杭州'), ['上个月去了苏州', '这个月去了杭州'])
  assert.deepEqual(facetsOf('I like tea and coffee'), ['I like tea', 'coffee'])
})

test('facets drop duplicates and cap at three', () => {
  assert.deepEqual(facetsOf('我喜欢评弹'), [])
  assert.deepEqual(facetsOf('去了苏州，去了苏州，去了苏州'), [])
  const capped = facetsOf('苹果，香蕉，梨，葡萄')
  assert.equal(capped.length, 3)
})
