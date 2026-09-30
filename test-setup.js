// Simple test script to verify project structure
// Run with: node test-setup.js

const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
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
  'api/verify.js',
  'api/feedback.js'
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
  console.log('2. Copy environment variables: cp .env.example .env.local');
  console.log('3. Add your API keys to .env.local');
  console.log('4. Start development server: npm run dev');
  console.log('5. Visit http://localhost:3000');
} else {
  console.log('⚠️  Some files are missing. Please check the project structure.');
}

console.log('\nFor deployment instructions, see README.md');