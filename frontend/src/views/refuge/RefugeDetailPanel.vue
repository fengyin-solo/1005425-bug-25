<template>
  <div class="refuge-panel" data-test="refuge-detail-panel">
    <div v-if="!row" class="panel-empty">
      <p>没有找到该避险场所，可能已被重置或编号有误。</p>
      <button v-if="embedded" class="btn" type="button" @click="emit('close')">关闭</button>
    </div>

    <template v-else>
      <header class="panel-head">
        <div>
          <h3>{{ row['场所名称'] }}</h3>
          <p class="panel-code">场所编号：{{ row['场所编号'] }} · 当前状态：{{ row.status }}</p>
        </div>
        <button v-if="embedded" class="btn ghost" type="button" @click="emit('close')">关闭</button>
      </header>

      <dl class="detail-grid">
        <div v-for="field in fields" :key="field" class="detail-item">
          <dt>{{ field }}</dt>
          <dd>
            <template v-if="field === '可容纳人数'">
              <span :class="['capacity-badge', capacityView.tone]">{{ capacityView.text }}</span>
            </template>
            <template v-else-if="field === '开放条件'">
              <span :class="['opening-badge', openingMet ? 'ok' : 'bad']">
                {{ openingDisplay }}
              </span>
            </template>
            <template v-else>{{ row[field] === '' || row[field] == null ? '—' : row[field] }}</template>
          </dd>
        </div>
      </dl>

      <section class="rule-box">
        <h4>启用判定（人数与开放条件打架时按此顺序）</h4>
        <ol>
          <li :class="{ muted: capacityView.tone === 'ok' }">
            可容纳人数是硬门槛、一票否决：缺失拦下单条并提示补齐；0、负数、小数、非数字等无效值一律退回重填。
          </li>
          <li :class="{ muted: openingMet }">
            人数有效后再看开放条件：须命中「常年开放 / 汛期开放 / 临险开放」约定口径，否则暂不启用。
          </li>
        </ol>
        <p :class="['eval-line', evaluation.canEnable ? 'ok' : 'bad']">{{ evaluation.reason }}</p>
      </section>

      <section class="flow-box">
        <h4>状态流转（待核验 → 可启用 → 已启用 → 已关闭，越级挡下）</h4>
        <ol class="flow-track">
          <li
            v-for="(status, index) in statuses"
            :key="status"
            :class="['flow-step', { active: status === row.status, done: isDone(index) }]"
          >
            {{ status }}
          </li>
        </ol>
      </section>

      <section class="edit-box">
        <h4>补齐 / 修正</h4>
        <div class="edit-row">
          <label class="edit-field">
            <span>可容纳人数</span>
            <input
              v-model="draft.capacity"
              inputmode="numeric"
              placeholder="大于 0 的正整数"
              @keyup.enter="savePatch"
            />
          </label>
          <label class="edit-field">
            <span>开放条件</span>
            <select v-model="draft.openCondition">
              <option value="">（未填写）</option>
              <option v-for="option in openingOptions" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <button class="btn primary" type="button" @click="savePatch">保存</button>
        </div>
      </section>

      <section v-if="nextAction" class="action-box">
        <h4>办理</h4>
        <button class="btn primary" type="button" @click="doAction(nextAction)">{{ nextAction }}</button>
      </section>

      <p v-if="message" :class="['panel-message', messageOk ? 'ok' : 'error-text']">{{ message }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

import {
  CAPACITY_FIELD,
  OPENING_FIELD,
  OPENING_OPTIONS,
  REFUGE_STATUSES,
  closeRefuge,
  describeCapacity,
  enableRefuge,
  evaluateEnable,
  getRefuge,
  isOpeningMet,
  nextActionFor,
  openingText,
  patchRefuge,
  reviewRefuge,
} from '@/api/refuge-service'
import type { EntryRow } from '@/data/types'

const props = defineProps<{ id: number | null; embedded?: boolean }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const fields = ['场所编号', '场所名称', '可容纳人数', '开放条件', '场所负责人', '联系电话', '启用日期', '场所状态']
const statuses = [...REFUGE_STATUSES]
const openingOptions = [...OPENING_OPTIONS]

const row = ref<EntryRow | undefined>()
const message = ref('')
const messageOk = ref(false)

const draft = reactive({ capacity: '', openCondition: '' })

const capacityView = computed(() => describeCapacity(row.value?.[CAPACITY_FIELD]))
const openingMet = computed(() => (row.value ? isOpeningMet(row.value[OPENING_FIELD]) : false))
const openingDisplay = computed(() => {
  if (!row.value) {
    return '—'
  }
  const text = openingText(row.value[OPENING_FIELD])
  return text === '' ? '未填写，不满足开放条件' : `${text}${openingMet.value ? '' : '（不在约定口径）'}`
})
const evaluation = computed(() =>
  row.value
    ? evaluateEnable(row.value)
    : { canEnable: false, reason: '', capacity: { kind: 'missing' as const }, openingMet: false },
)
const nextAction = computed(() => (row.value ? nextActionFor(String(row.value.status)) : ''))

function isDone(index: number): boolean {
  if (!row.value) {
    return false
  }
  const current = statuses.indexOf(String(row.value.status) as (typeof statuses)[number])
  return index < current
}

function load(): void {
  row.value = props.id == null ? undefined : getRefuge(props.id)
  message.value = ''
  messageOk.value = false
  draft.capacity = row.value ? String(row.value[CAPACITY_FIELD] ?? '') : ''
  draft.openCondition = row.value ? openingText(row.value[OPENING_FIELD]) : ''
}

watch(() => props.id, load, { immediate: true })

function savePatch(): void {
  if (!row.value || props.id == null) {
    return
  }
  const result = patchRefuge(props.id, {
    capacity: draft.capacity,
    openCondition: draft.openCondition,
  })
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    load()
    emit('changed')
  }
}

function doAction(action: string): void {
  if (!row.value || props.id == null) {
    return
  }
  const runner =
    action === '提交核验' ? reviewRefuge : action === '确认启用' ? enableRefuge : closeRefuge
  const result = runner(props.id)
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    load()
    emit('changed')
  }
}
</script>
