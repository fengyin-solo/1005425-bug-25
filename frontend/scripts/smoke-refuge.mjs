// 领域逻辑冒烟脚本：用 esbuild 现场把 TS 源码打成 CJS，在 Node 里跑通关键分支。
// 不依赖浏览器，不进生产包。运行：node scripts/smoke-refuge.mjs
import { build } from 'esbuild'
import { writeFileSync, rmSync } from 'node:fs'

const harness = `
import {
  batchEnable, batchReview, closeRefuge, describeCapacity, enableRefuge,
  evaluateEnable, getRefuge, isOpeningMet, parseCapacity, patchRefuge, reviewRefuge,
} from '@/api/refuge-service'
import { listImplementedShelters } from '@/data/cutting-ledger'
import { resetRows } from '@/data/local-store'

let failures = 0
function check(name, cond) {
  if (cond) { console.log('PASS', name) }
  else { failures += 1; console.error('FAIL', name) }
}

// 容量解析
check('空串=缺失', parseCapacity('').kind === 'missing')
check('undefined=缺失', parseCapacity(undefined).kind === 'missing')
check('0=无效', parseCapacity('0').kind === 'invalid')
check('负数=无效', parseCapacity('-5').kind === 'invalid')
check('小数=无效', parseCapacity('12.5').kind === 'invalid')
check('非数字=无效', parseCapacity('abc').kind === 'invalid')
check('正整数=有效', parseCapacity('300').kind === 'valid')
check('带空格正整数=有效', parseCapacity(' 300 ').kind === 'valid')

// 开放条件口径
check('常年开放满足', isOpeningMet('常年开放'))
check('空白不满足', !isOpeningMet('  '))
check('自由文本不满足', !isOpeningMet('另行通知'))

// 重置为示例数据
resetRows('refuge')
resetRows('cutting')

// id1 待核验、人数 300、常年开放 -> 核验通过并挂台账
let r = reviewRefuge(1)
check('id1 核验通过', r.ok)
check('台账挂入 1 条', listImplementedShelters().length >= 1)
check('台账含 REFU-0001', listImplementedShelters().some((x) => x.场所编号 === 'REFU-0001'))
// 同一条场所编号再走一次复核（已经是可启用，重复复核挡下，不重复挂）
r = reviewRefuge(1)
check('重复复核被挡', !r.ok)
const countAfterRepeat = listImplementedShelters().length
reviewRefuge(1)
check('重复复核台账不新增', listImplementedShelters().length === countAfterRepeat)

// id2 待核验、人数缺失 -> 单独拦下
r = reviewRefuge(2)
check('id2 人数缺失核验被拦', !r.ok && /缺失/.test(r.message))
check('id2 仍为待核验', String(getRefuge(2).status) === '待核验')

// id3 待核验、人数 0 -> 退回重填
r = reviewRefuge(3)
check('id3 人数为0核验被退回', !r.ok && /无效/.test(r.message))

// 越级：id1 现在可启用，不能直接关闭
r = closeRefuge(1)
check('可启用直接关闭被越级挡下', !r.ok && /越级/.test(r.message))
// 越级：待核验的 id2 不能直接启用
r = enableRefuge(2)
check('待核验直接启用被挡', !r.ok)

// id5 可启用、开放条件为「另行通知」-> 启用挡下（人数优先：先报开放条件，因为人数有效）
r = enableRefuge(5)
check('id5 开放条件不符启用被挡', !r.ok && /开放条件/.test(r.message))

// id6 可启用、人数缺失 -> 提示补齐
r = enableRefuge(6)
check('id6 人数缺失启用被拦提示补齐', !r.ok && /缺失|补齐/.test(r.message))

// 编辑补齐 id6 人数为空保存允许（标记缺失），填 -1 保存被退回
r = patchRefuge(6, { capacity: '-1' })
check('保存负数人数被退回重填', !r.ok && /无效/.test(r.message))
r = patchRefuge(6, { capacity: '0' })
check('保存0人数被退回重填', !r.ok)
r = patchRefuge(6, { capacity: '  ' })
check('清空人数允许（标记待补齐）', r.ok && parseCapacity(getRefuge(6)['可容纳人数']).kind === 'missing')
// 开放条件从「另行通知」改成临险开放（id5 人数有效，改完即可启用）
r = patchRefuge(5, { openCondition: '临险开放' })
check('id5 开放条件改为临险开放', r.ok)

// 批量核验：待核验里 id1 已处理，id2 缺人数拦、id3 零人数拦（都失败，不整批异常）
let b = batchReview()
check('批量核验有空缺/无效逐条失败', !b.empty && b.succeeded === 0 && b.failed === 2)
check('批量核验汇总提示逐条拦下', /逐条拦下/.test(b.summary))
check('批量结果逐条带编号', b.items.every((i) => /REFU-000[23]/.test(i.message)))

// 批量启用：id1/id4 通过；id5 开放条件此时已补齐也通过；id6 人数缺失被单独拦下，不影响其他场所
b = batchEnable()
check('批量启用存在可启用项', !b.empty)
check('批量启用 id1/id4/id5 通过', b.items.filter((i) => i.ok).length === 3)
check('id6 缺人在批量启用里被单列', b.items.some((i) => i.code === 'REFU-0006' && !i.ok && /补齐/.test(i.message)))
// id1 已随批量启用，状态应为已启用
check('id1 已随批量启用', String(getRefuge(1).status) === '已启用')

// 补 id6 人数后第二批把它启用，再下一批无可启用 -> 空态说明
r = patchRefuge(6, { capacity: '200' })
check('id6 补齐人数成功', r.ok)
b = batchEnable()
check('id6 补齐后第二批启用', b.succeeded === 1)
b = batchEnable()
check('无可启用场所给空态', b.empty && /没有可启用/.test(b.summary))

// id1 已启用，可关闭；关闭后不可再关/再启用
r = closeRefuge(1)
check('id1 启用后可关闭', r.ok)
r = enableRefuge(1)
check('已关闭不能再启用', !r.ok)

// 台账去重：id2 补齐后核验只新增 REFU-0002，REFU-0001 仍只一条
patchRefuge(2, { capacity: '120', openCondition: '汛期开放' })
reviewRefuge(2)
check('台账 REFU-0001 仍唯一', listImplementedShelters().filter((x) => x.场所编号 === 'REFU-0001').length === 1)
check('台账新增 REFU-0002', listImplementedShelters().some((x) => x.场所编号 === 'REFU-0002'))

// 抽屉与详情共用判定：evaluateEnable 与徽标口径一致
check('徽标口径与解析一致', describeCapacity(getRefuge(3)['可容纳人数']).tone === 'invalid')
check('evaluateEnable 对已关闭场所判否', evaluateEnable(getRefuge(1)).canEnable === false)

if (failures > 0) { console.error('\\n' + failures + ' 项失败'); process.exit(1) }
console.log('\\n全部通过')
`

writeFileSync('/tmp/refuge-smoke-entry.ts', harness)

await build({
  entryPoints: ['/tmp/refuge-smoke-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: '/tmp/refuge-smoke.mjs',
  alias: { '@': '/workspace/frontend/src' },
  inject: ['/workspace/frontend/scripts/localStorage-shim.mjs'],
  logLevel: 'silent',
})
rmSync('/tmp/refuge-smoke-entry.ts')
await import('/tmp/refuge-smoke.mjs')
