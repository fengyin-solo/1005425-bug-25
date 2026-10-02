<template>
  <section class="page refuge-detail-page" data-module="refuge-detail">
    <header class="page-head">
      <div>
        <h2>避险场所详情</h2>
        <p class="page-desc">详情页与列表侧栏抽屉共用同一份数据与启用判定口径，人数、开放条件不会两样。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" :to="{ name: 'refuge' }">返回避险场所列表</RouterLink>
      </div>
    </header>

    <div class="detail-page-card">
      <RefugeDetailPanel :id="routeId" @changed="() => {}" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import RefugeDetailPanel from './RefugeDetailPanel.vue'

const route = useRoute()
const routeId = computed(() => {
  const id = Number(route.params.id)
  return Number.isFinite(id) ? id : null
})
</script>
