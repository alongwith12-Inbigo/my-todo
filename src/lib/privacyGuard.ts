export type PiiCategory =
  | 'resident_id'
  | 'passport_or_card'
  | 'bank_account'
  | 'phone'
  | 'email'
  | 'student_id'
  | 'person_name';

export type PiiSeverity = 'high' | 'medium';

export interface PiiFinding {
  category: PiiCategory;
  label: string;
  severity: PiiSeverity;
  count: number;
}

export interface PrivacyInspectionResult {
  originalText: string;
  maskedText: string;
  hasPii: boolean;
  hasHighRisk: boolean;
  findings: PiiFinding[];
}

interface PiiRule {
  category: PiiCategory;
  label: string;
  severity: PiiSeverity;
  pattern: RegExp;
  replaceFn: (...args: string[]) => string;
}

const PII_RULES: PiiRule[] = [
  {
    category: 'resident_id',
    label: '주민등록번호·외국인등록번호 유사 숫자',
    severity: 'high',
    pattern: /\b\d{6}\s*-\s*[1-8]\d{6}\b/g,
    replaceFn: () => '[고유식별번호 제외됨]',
  },
  {
    category: 'passport_or_card',
    label: '카드번호·여권번호 유사 패턴',
    severity: 'high',
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b|(?:여권\s*(?:번호)?\s*[:：]?\s*[A-Z]{1,2}\d{7,8})/gi,
    replaceFn: () => '[금융·여권번호 제외됨]',
  },
  {
    category: 'bank_account',
    label: '계좌번호 포함 가능 문맥',
    severity: 'high',
    pattern: /(계좌\s*(?:번호)?\s*[:：]?\s*)(?:\d{2,6}[-\s]?){2,4}\d{2,6}/g,
    replaceFn: (_full, prefix) => `${prefix}[계좌번호 제외됨]`,
  },
  {
    category: 'phone',
    label: '전화번호·휴대전화 번호',
    severity: 'medium',
    pattern: /(?:\b01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}\b|\b0(?:2|[3-6]\d)[-\s.]?\d{3,4}[-\s.]?\d{4}\b)/g,
    replaceFn: () => '[연락처]',
  },
  {
    category: 'email',
    label: '이메일 주소',
    severity: 'medium',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replaceFn: () => '[이메일]',
  },
  {
    category: 'student_id',
    label: '학번·학년반번호 식별 정보',
    severity: 'medium',
    pattern: /(?:\d{1}학년\s*\d{1,2}반\s*\d{1,2}번|(?:학번\s*[:：]?\s*)\d{4,10}|\b[1-3]0\d{3}\b(?=\s*(?:학생|[가-힣]{2,4})))/g,
    replaceFn: () => '[학번/반번호]',
  },
  {
    category: 'person_name',
    label: '학생·학부모·교직원 성명 문맥',
    severity: 'medium',
    pattern:
      /((?:성명|이름|학생명|학부모명|보호자명|대상자|작성자|신청자)\s*[:：]\s*)([가-힣]{2,4})|(?<![가-힣])([가-힣]{2,4})(\s*(?:학생|학부모|어머님|아버님|보호자|선생님|교사|담임))(?![가-힣])/g,
    replaceFn: (full, labelPrefix, labeledName, bareName, roleSuffix) => {
      const NON_PERSON_WORDS = new Set([
        '전체',
        '모든',
        '해당',
        '대상',
        '담당',
        '신규',
        '기존',
        '교과',
        '학급',
        '학년',
        '전담',
        '수석',
        '보조',
        '참여',
        '신청',
        '희망',
        '상담',
        '기간제',
        '보건',
        '특수',
        '영양',
        '사서',
        '전문',
      ]);
      if (labelPrefix && labeledName) {
        return `${labelPrefix}[성명]`;
      }
      if (bareName && roleSuffix) {
        if (NON_PERSON_WORDS.has(bareName)) {
          return full;
        }
        return `[성명]${roleSuffix}`;
      }
      return '[성명]';
    },
  },
];

export function inspectAndMaskPrivacy(rawText: string): PrivacyInspectionResult {
  const originalText = rawText ?? '';
  let working = originalText;
  const findings: PiiFinding[] = [];

  for (const rule of PII_RULES) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let count = 0;
    working = working.replace(regex, (...args) => {
      const full = args[0] as string;
      const replaced = rule.replaceFn(...(args as string[]));
      if (replaced !== full) {
        count += 1;
      }
      return replaced;
    });
    if (count > 0) {
      findings.push({
        category: rule.category,
        label: rule.label,
        severity: rule.severity,
        count,
      });
    }
  }

  return {
    originalText,
    maskedText: working,
    hasPii: findings.length > 0,
    hasHighRisk: findings.some((f) => f.severity === 'high'),
    findings,
  };
}

export function sanitizeMinimalFieldForAi(text: string): string {
  return inspectAndMaskPrivacy(text).maskedText;
}
