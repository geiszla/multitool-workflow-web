import antfu from '@antfu/eslint-config'

export default antfu({
  react: true,
  typescript: true,
  ignores: ['build/', '.react-router/', 'docs/', 'OVERVIEW.md', '*.md'],
  rules: {
    // Allow process.env in server-side code (React Router framework)
    'node/prefer-global/process': 'off',
  },
})
