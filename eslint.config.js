import antfu from '@antfu/eslint-config'

export default antfu({
  react: true,
  typescript: true,
  ignores: ['build/', '.react-router/', 'docs/', '*.md'],
  rules: {
    // Allow process.env in server-side code (React Router framework)
    'node/prefer-global/process': 'off',
  },
}, {
  // VM agent scripts run on Node.js - allow Node.js globals and console
  files: ['vm-agent/**/*.js'],
  rules: {
    'no-console': 'off',
    'node/prefer-global/buffer': 'off',
  },
})
