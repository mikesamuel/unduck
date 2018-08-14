use strict;

while (<>) {
    if (m/^##(#*) (.*?) <span name="([^"]*)"><\/span>\s*$/) {
        my $indentation = $1;
        my $text = $2;
        my $fragment = $3;

        $indentation =~ s/#/    /g;
        $text =~ s/\s+$//;
        # Abbreviate parameter lists.
        $text =~ s/\([\.\w, ]+\)/(...)/;

        print "$indentation\*  [$text](#$fragment)\n";
    }
}
