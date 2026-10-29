import type { Register } from 'claude-code'

import { registerHub } from './hub'
import { registerProgress } from './progress'
import { registerRunner } from './runner'

export const register: Register = (on, options) => {
  registerProgress(on, options)
  registerRunner(on, options)
  registerHub(on, options)
}
