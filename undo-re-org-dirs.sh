#!/bin/bash

# Go through every directory in the folder "public/gifs"
for dir in public/gifs/*/; do
  # Check if the directory name does NOT contain a hyphen
  if [[ $dir != *-* ]]; then
    # Go into the directory
    echo "cd $dir"
    cd "$dir"
    # Move every directory that contains a hyphen to the "public/gifs" directory
    for subdir in */; do
      if [[ $subdir == *-* ]]; then
        echo "#mv $subdir .."
        mv $subdir ..
      fi
    done
    # Go back to the "public/gifs" directory
    cd ../../..
  fi
done