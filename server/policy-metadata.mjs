// 人工审定记录。审定依据见 spec §9.1——本文件是那份审定的可执行形式。
// reviewedAgainst 由 Task 2 的 reviewShapeHash 回填;此处先留空串,
// Task 2 的测试会断言它已被填成真实哈希。
export const REVIEWED_RECORDS = new Map([
  ['trae-cn/setup', {
    reviewedAgainst: '',
    metadata: {
      executionPath: 'direct-node',
      // 空集:它只打印本地 setup 说明文本,不访问网络、不读用户文件。
      authorities: [],
      exposure: 'public',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
  ['mercury/reimbursement-plan', {
    reviewedAgainst: '',
    metadata: {
      executionPath: 'direct-node',
      // 用户在本次调用中显式指定报销资料(receipt/amount/merchant/notes 均必填)。
      authorities: ['explicit-local-input'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
  ['antigravity/recent-paths', {
    reviewedAgainst: '',
    metadata: {
      executionPath: 'direct-node',
      // 主动扫描 Antigravity 的 history.recentlyOpenedPathsList——用户没指定读什么。
      authorities: ['ambient-local-files'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
])
