const fs = require('fs/promises');
const path = require('path');

const resolvePaths = require('./resolvePaths');
const renderSASS = require('./renderSASS');
const renderPug = require('./renderPug');
const renderTemplates = require('./renderTemplates');
const { reporter } = require('./reporter');

const isSASS = async ({entry,source:resSource,destination:resDest,options,runSCSS,sfcStyles,sfcFonts}) => {
  if(
    (
      runSCSS ||
      sfcStyles?.roll?.trim() ||
      sfcStyles?.sheet?.trim()
    ) && 
    entry.name.endsWith('.scss')){
    return renderSASS({source:resSource,destination:resDest,options,sfcStyles,sfcFonts});
  }
};

const isPUG = async ({entry,source:resSource,destination:resDest,testDestination,options,runPUG,templates}) => {
  if(runPUG && entry.name.endsWith('.pug')){
    return renderPug({source:resSource,destination:resDest,testDestination,options,templates});
  }
  return [];
};

const processSheet = async ({source ='./',destination,dynamicDestination = false,testDestination,pugOptions={suppressStack:true},scssOptions={},runSCSS=true,runPUG=true, templates}) => {
  reporter.startCycle();
  // fs.opendir / fs.readdir return entries in filesystem order, which differs
  // across platforms (NTFS = alphabetical, ext4 = insertion order). Sort
  // alphabetically so test_sheet builds — which intentionally name the final
  // sheet with a leading 'z' so its testFramework.js wins the per-pug overwrite —
  // are deterministic on Linux CI as well as Windows/macOS dev machines.
  const files = (await fs.readdir(source, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const pugPromises = [];
  const scssPromises = [];
  const destinations = {};
  const sfcStyles = {};
  const sfcFonts = {};
  for (const entry of files){
    if(entry.isFile() && !entry.name.startsWith('_') && (
      entry.name.endsWith('.pug') ||
      entry.name.endsWith('.scss')
    )){
      const [resSource,resDest] = resolvePaths(source,destination,dynamicDestination,entry);

      // Ensure the destination directory exists
      const existingDest = path.dirname(resDest);
      await fs.mkdir(existingDest,{recursive:true});

      const [,destDir,fileName] = resDest.match(/(.+?)[\\\/]([^\\\/]+)$/) || [];
      if(destDir && fileName){
        destinations[destDir] = destinations[destDir] || [];
        destinations[destDir].push(fileName);
      }

      const [newPUG,sfc,fontArray] = await isPUG({entry,source:resSource,destination:resDest,testDestination,options:pugOptions,runPUG,templates});
      if(sfc){
        sfcStyles[entry.name.replace(/(?:pug)$/,'scss')] = sfc;
      }
      if(fontArray?.length){
        sfcFonts[entry.name.replace(/(?:pug)$/,'scss')] = fontArray;
      }

      const newSASS = await isSASS({entry,source:resSource,destination:resDest,options:scssOptions,runSCSS,sfcStyles:sfcStyles[entry.name],sfcFonts:sfcFonts[entry.name]});

      if(newSASS){
        scssPromises.push(newSASS);
      }
      if(newPUG){
        pugPromises.push(newPUG);
      }
    }
  }
  const pugOutput = await Promise.all(pugPromises);
  const scssOutput = await Promise.all(scssPromises);
  const templateOutput = await renderTemplates(destinations,templates);
  return [pugOutput,scssOutput,templateOutput];
};

module.exports = processSheet;