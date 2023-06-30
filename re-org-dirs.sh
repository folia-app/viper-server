#!/bin/bash

# Go through every directory in the folder "public/gifs"
for dir in public/gifs/*/; do
  # Check if the directory name contains a hyphen
  if [[ $dir == *-* ]]; then
    # Extract the part of the directory name before the hyphen
    new_dir=${dir%-*}
    # echo "new_dir is $new_dir"

    # Extract the part of the directory name after the hyphen (do it twice in case ${network}-gifs is being used)
    file_name=${dir#*-}
    # echo "file_name is $file_name"
    file_name=${file_name#*-}
    # echo "file_name is $file_name"

    # Create a new directory with the extracted name
    echo "make dir $new_dir/"
    mkdir -p "$new_dir/"

    # Move the original directory into the new directory, renaming the directory with the extracted name
    echo "move $dir to $new_dir/$file_name"
    mv "$dir" "$new_dir/$file_name"
    echo "---"
  fi
done