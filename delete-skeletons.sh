#!/bin/bash

# List of numbers to match in the folder names
# numbers=('0010' '0014' '0019' '0028' '0033' '0056' '0106' '0114' '0119' '0155' '0161' '0172' '0228' '0231' '0236' '0245' '0246' '0249' '0268' '0277' '0302' '0304' '0401' '0418' '0423' '0426' '0024' '0032' '0049' '0063' '0068' '0070' '0087' '0095' '0113' '0137' '0149' '0154' '0158' '0166' '0196' '0247' '0264' '0269' '0281' '0318' '0324' '0374' '0379' '0412' '0425' '0428')

# these are the circle animations
numbers=('5' '23' '27' '42' '43' '46' '71' '73' '94' '100' '110' '115' '120' '137' '143' '145' '146' '148' '156' '165' '194' '196' '197' '208' '210' '215' '226' '253' '266' '271' '292' '293' '299' '301' '306' '314' '319' '321' '327' '337' '348' '351' '365' '373' '383' '385' '392' '393' '397' '399' '400' '404' '420' '427' '429' '434' '438' '439' '441' '469')
# Change to the "public/gifs" directory
cd public/gifs

# Iterate over each directory
for dir in *-*/; do
  # Extract the first part of the directory name
  prefix=${dir%%-*}

  # Check if the prefix matches one of the numbers
  if [[ " ${numbers[*]} " == *" ${prefix} "* ]]; then
    # Delete the directory and its contents
    rm -rf "$dir"
    echo "$dir deleted"
  fi
done