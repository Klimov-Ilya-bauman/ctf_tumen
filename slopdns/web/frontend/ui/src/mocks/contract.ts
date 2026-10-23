export interface ContractViolation {
  direction: 'request' | 'response'
  schema: string
  field: string
  message: string
}

export interface ContractValidator {
  check(schema: string, value: unknown, direction: 'request' | 'response'): ContractViolation | null
}

export const permissiveValidator: ContractValidator = {
  check: () => null,
}
