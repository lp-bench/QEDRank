// Simple test script to verify project structure
// Run with: node test-setup.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const requiredFiles = [
  'package.json',
  'vite.config.js',
  'index.html',
  '.env.example',
  'README.md',
  'supabase-setup.sql',
  '.gitignore',
  'src/main.jsx',
  'src/App.jsx',
  'src/index.css',
  'src/App.css',
  'src/state/AppState.jsx',
  'src/pages/HomePage.jsx',
  'src/pages/BenchmarkPage.jsx',
  'src/evaluation/EvaluationPage.jsx',
  'lib/providers.js',
  'api/verify.js',
  'api/models.js',
  'api/feedback.js',
  'scripts/set-llm-keys.ps1'
];

console.log('🔍 QEDengine Project Structure Verification\n');

let allFilesExist = true;

requiredFiles.forEach(file => {
  const filePath = path.join(projectRoot, file);
  if (fs.existsSync(filePath)) {
    console.log(`✅ ${file}`);
  } else {
    console.log(`❌ ${file} - MISSING`);
    allFilesExist = false;
  }
});

console.log('\n' + '='.repeat(50));

if (allFilesExist) {
  console.log('🎉 All required files are present!');
  console.log('\nNext steps:');
  console.log('1. Install dependencies: npm install');
  console.log('2. Add API keys with hidden input: .\\scripts\\set-llm-keys.ps1 -Target User');
  console.log('   (or copy .env.example to .env.local and fill it in)');
  console.log('3. Check the roster: node qedrank/cli.js models');
  console.log('4. Start development server: npm run dev');
  console.log('5. Visit http://localhost:3000');
} else {
  console.log('⚠️  Some files are missing. Please check the project structure.');
}

console.log('\nFor deployment instructions, see README.md');
