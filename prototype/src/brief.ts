// TaskBrief — theo Worker Protocol spec v0.1 §7 (luật B1–B4)
export type NodeType =
  | 'plan'
  | 'implement'
  | 'verify'
  | 'review'
  | 'check'
  | 'run'
  | 'merge_gate';

export interface TaskBrief {
  task_id: string;
  node: NodeType;
  role: string;
  goal: string;
  /** hàng rào — glob patterns; worker chỉ được chạm file khớp mẫu này */
  files_in_scope: string[];
  constraints: string[];
  forbidden_actions: string[];
  acceptance_criteria: string[];
  artifacts_out: string[];
  budget?: { usd?: number; minutes?: number };
  worktree?: string;
  worker?: string;
  model?: string;
  tags?: string[];
  memory?: { hits: string[]; dropped?: string[] };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export const DEFAULT_ARTIFACTS: Record<NodeType, string[]> = {
  plan: ['plan'],
  implement: ['diff'],
  verify: ['test_report'],
  review: ['verdict'],
  check: ['report'],
  run: ['report'],
  merge_gate: ['merge_result'],
};

export function validateBrief(b: TaskBrief): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!b.goal.trim()) errors.push('B1: goal rỗng');

  // B1: hàng rào bắt buộc, node plan là ngoại lệ (brief của plan chính là task gốc)
  if (b.node !== 'plan' && b.files_in_scope.length === 0) {
    errors.push('B1: files_in_scope rỗng — brief thiếu hàng rào, từ chối dispatch');
  }
  if (!b.acceptance_criteria.length) {
    warnings.push('B1: acceptance_criteria rỗng — gate sẽ không có gì để chấm');
  }
  if (b.node === 'plan' && b.files_in_scope.length === 0) {
    warnings.push('plan không có scope gợi ý — worker sẽ tự khảo sát toàn repo');
  }
  return { ok: errors.length === 0, errors, warnings };
}
