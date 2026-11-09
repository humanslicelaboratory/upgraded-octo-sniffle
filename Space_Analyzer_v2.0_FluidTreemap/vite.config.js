const {defineConfig}=require('vite');
module.exports=defineConfig({root:'.',server:{port:5173},build:{outDir:'dist',emptyOutDir:true}});