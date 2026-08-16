$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outDir = Join-Path $root 'promo'
$outFile = Join-Path $outDir 'dablaja-opener.mp4'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$filter = @"
drawbox=x=0:y=0:w=iw:h=ih:color=#071a2c:t=fill,
drawbox=x=0:y=0:w=iw:h=ih:color=#0b3850@0.18:t=fill,
drawtext=fontfile='C\:/Windows/Fonts/seguisb.ttf':text='d':x=685:y=445:fontsize=110:fontcolor=#f5fbff:alpha='if(lt(t,0.35),0,if(lt(t,0.5),(t-0.35)/0.15,if(gt(t,3.45),max(0,1-(t-3.45)/0.75),1)))':enable='gte(t,0.35)',
drawtext=fontfile='C\:/Windows/Fonts/seguisb.ttf':text='a':x=755:y=445:fontsize=110:fontcolor=#f5fbff:alpha='if(lt(t,0.60),0,if(lt(t,0.75),(t-0.60)/0.15,if(gt(t,3.45),max(0,1-(t-3.45)/0.75),1)))':enable='gte(t,0.60)',
drawtext=fontfile='C\:/Windows/Fonts/seguisb.ttf':text='b':x=820:y=445:fontsize=110:fontcolor=#f5fbff:alpha='if(lt(t,0.85),0,if(lt(t,1.00),(t-0.85)/0.15,if(gt(t,3.45),max(0,1-(t-3.45)/0.75),1)))':enable='gte(t,0.85)',
drawtext=fontfile='C\:/Windows/Fonts/seguisb.ttf':text='l':x=890:y=445:fontsize=110:fontcolor=#f5fbff:alpha='if(lt(t,1.10),0,if(lt(t,1.25),(t-1.10)/0.15,if(gt(t,3.45),max(0,1-(t-3.45)/0.75),1)))':enable='gte(t,1.10)',
drawtext=fontfile='C\:/Windows/Fonts/seguisb.ttf':text='a':x=930:y=445:fontsize=110:fontcolor=#f5fbff:alpha='if(lt(t,1.35),0,if(lt(t,1.50),(t-1.35)/0.15,if(gt(t,3.45),max(0,1-(t-3.45)/0.75),1)))':enable='gte(t,1.35)',
drawtext=fontfile='C\:/Windows/Fonts/seguisb.ttf':text='j':x=995:y=445:fontsize=110:fontcolor=#f5fbff:alpha='if(lt(t,1.60),0,if(lt(t,1.75),(t-1.60)/0.15,if(gt(t,3.45),max(0,1-(t-3.45)/0.75),1)))':enable='gte(t,1.60)',
drawtext=fontfile='C\:/Windows/Fonts/seguisb.ttf':text='a':x=1050:y=445:fontsize=110:fontcolor=#f5fbff:alpha='if(lt(t,1.85),0,if(lt(t,2.00),(t-1.85)/0.15,if(gt(t,3.45),max(0,1-(t-3.45)/0.75),1)))':enable='gte(t,1.85)',
drawtext=fontfile='C\:/Windows/Fonts/seguisb.ttf':text='|':x=1130:y=448:fontsize=95:fontcolor=#2ad4c4:alpha='if(lt(t,0.35),0,if(gt(t,3.55),max(0,1-(t-3.55)/0.55),1))':enable='between(t,0.35,3.9)',
drawtext=fontfile='C\:/Windows/Fonts/segoeui.ttf':text='DABLAJA':x=(w-text_w)/2:y=590:fontsize=25:fontcolor=#8feee4:alpha='if(lt(t,2.15),0,if(lt(t,2.55),(t-2.15)/0.4,if(gt(t,3.45),max(0,1-(t-3.45)/0.75),1)))':enable='gte(t,2.15)'
"@

& ffmpeg -y -f lavfi -i "color=c=#071a2c:s=1920x1080:r=30:d=4.4" -vf $filter -an -c:v libx264 -pix_fmt yuv420p -profile:v high -crf 18 -movflags +faststart $outFile
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed with exit code $LASTEXITCODE" }
Write-Output $outFile
